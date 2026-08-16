import sharp from 'sharp'

// P2 consent audit, C1: the kurator-only `exifLat`/`exifLng` FIELDS gate who can read a photo's
// coordinates through the document API — but the stored ORIGINAL file still carries the same GPS
// inside its EXIF, and two paths stream that original blob to callers who never pass through
// field access: the anonymous kiosk download route and Payload's own /api/photos/file/:filename.
// So the coordinate must be removed from the file bytes themselves at upload. It is preserved for
// curators regardless — extractExifOnUpload reads it into the DB fields BEFORE this strip runs.
//
// Two review findings shaped this file (adversarial pass, commit history):
//   F1 — a "JPEG" can be more than one image: iPhone MPF/HDR gain-maps and Samsung "motion photos"
//        append a SECOND full JPEG, with its OWN EXIF/GPS, after the primary image's EOI. So the
//        walker stops at the primary EOI and discards the trailer, and drops the MPF (APP2) index.
//   F2 — the client's declared mimetype cannot be trusted (JPEG-with-GPS uploaded as image/heic
//        would skip a mimetype-gated scrub yet be sniff-accepted by Payload). So the caller sniffs
//        the ACTUAL format from magic bytes and drives the scrub off that, never off the label.

export type SniffedImageType = 'jpeg' | 'png' | 'tiff' | 'webp' | 'heic'

// HEIC/HEIF (and AVIF) brands that mark an ISOBMFF `ftyp` box as a still image carrying EXIF.
const HEIF_BRAND = /^(heic|heix|heif|hevc|hevx|heim|heis|hevm|hevs|mif1|msf1|avif)$/

/**
 * Identify an image's real format from its leading magic bytes, ignoring any client-declared
 * mimetype (F2). Returns null for anything not one of our stored raster types — the caller then
 * leaves the file for Payload's own checkFileRestrictions to accept or reject.
 */
export function detectImageType(buf: Buffer): SniffedImageType | null {
  if (buf.length < 12) return null
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg'
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png'
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'webp'
  }
  if (
    (buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00) ||
    (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a)
  ) {
    return 'tiff'
  }
  // ISOBMFF container: bytes 4..8 are 'ftyp', then a major brand and a list of compatible brands.
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brands = new Set<string>([buf.subarray(8, 12).toString('latin1')])
    // Compatible brands follow the (major brand + minor version); scan a bounded window of them.
    for (let o = 16; o + 4 <= Math.min(buf.length, 64); o += 4) {
      brands.add(buf.subarray(o, o + 4).toString('latin1'))
    }
    for (const b of brands) if (HEIF_BRAND.test(b)) return 'heic'
  }
  return null
}

// JPEG APPn/marker segments dropped because they can carry location/identity metadata:
//   APP1 (0xE1): EXIF (including the GPS IFD) and XMP
//   APP13 (0xED): Photoshop Image Resource Block / IPTC (can also carry a location)
//   APP2 (0xE2): dropped ONLY when it is an MPF (Multi-Picture Format) index — that box points at
//                the appended secondary image this walker discards; a non-MPF APP2 (an ICC colour
//                profile) is KEPT so colours are preserved.
// Everything else — APP0/JFIF, the ICC APP2, the quantization and Huffman tables, the frame header
// and the entropy-coded scan — is copied through byte-for-byte, so the DECODED pixels are
// bit-identical to the original. This is a metadata scrub, not a re-encode.
const DROP_APP_MARKERS = new Set([0xe1, 0xed])
// Standalone markers (no 2-byte length field) that can appear in the header region. NOT D8 (SOI,
// already consumed) or D9 (EOI, handled explicitly as the primary-image terminator).
const STANDALONE_MARKERS = new Set([0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7])

/**
 * Losslessly remove the metadata segments that can hold location/identity data from a JPEG,
 * without decoding or re-encoding the pixels, and discard any image appended after the primary
 * one. Returns the scrubbed buffer.
 *
 * Throws if the input is not a structurally valid JPEG — the caller (stripImageMetadata) decides
 * the fallback, which is a guaranteed-strip re-encode, so a scrub failure never means a leaky
 * original gets stored.
 */
export function stripJpegMetadata(buf: Buffer): Buffer {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    throw new Error('not a JPEG (missing SOI marker)')
  }
  const out: Buffer[] = [buf.subarray(0, 2)] // SOI
  let i = 2
  while (i < buf.length) {
    if (buf[i] !== 0xff) throw new Error(`expected a marker at byte ${i}`)
    // A marker is FF followed by the first non-FF byte; extra FFs are legal fill bytes.
    let m = i
    while (m < buf.length && buf[m] === 0xff) m++
    if (m >= buf.length) throw new Error('truncated marker')
    const marker = buf[m]
    const markerStart = i
    i = m + 1

    if (marker === 0xd9) {
      // EOI: the end of the PRIMARY image. Copy it and STOP — anything after it is an appended
      // image (MPF secondary, HDR gain-map, motion-photo trailer) that carries its own EXIF/GPS
      // and must not be stored (F1).
      out.push(buf.subarray(markerStart, i))
      return Buffer.concat(out)
    }
    if (marker === 0xda) {
      // Start of Scan: copy the SOS header, then its entropy-coded data up to the next real marker.
      // (A baseline JPEG has one scan then EOI; a progressive JPEG has several, so we must resume
      // the marker loop rather than blindly copying to end-of-buffer.)
      if (i + 2 > buf.length) throw new Error('truncated SOS length')
      const headerLen = buf.readUInt16BE(i)
      const headerEnd = i + headerLen
      if (headerEnd > buf.length) throw new Error('SOS header overruns buffer')
      let k = headerEnd
      while (k < buf.length) {
        if (buf[k] === 0xff) {
          const next = buf[k + 1]
          if (next === undefined) {
            k = buf.length
            break
          }
          // 0x00 = a stuffed literal FF; 0xD0..0xD7 = a restart marker — both are scan data, not the
          // next segment. Anything else is the next real marker (another SOS, DHT, DNL, or EOI).
          if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
            k += 2
            continue
          }
          break
        }
        k++
      }
      out.push(buf.subarray(markerStart, k))
      i = k
      continue
    }
    if (STANDALONE_MARKERS.has(marker)) {
      out.push(buf.subarray(markerStart, i))
      continue
    }
    // Length-bearing segment: big-endian length that INCLUDES its own 2 length bytes.
    if (i + 2 > buf.length) throw new Error('truncated segment length')
    const len = buf.readUInt16BE(i)
    if (len < 2) throw new Error('invalid segment length')
    const segEnd = i + len
    if (segEnd > buf.length) throw new Error('segment overruns buffer')

    let drop = DROP_APP_MARKERS.has(marker)
    if (marker === 0xe2) {
      // APP2: keep the ICC colour profile, drop the MPF index that references the appended image.
      const id = buf.subarray(i + 2, Math.min(i + 2 + 4, segEnd)).toString('latin1')
      if (id.startsWith('MPF')) drop = true
    }
    if (!drop) out.push(buf.subarray(markerStart, segEnd))
    i = segEnd
  }
  // Reached the end without an explicit EOI — unusual but not fatal; return what we assembled.
  return Buffer.concat(out)
}

/**
 * Remove location/identity metadata from a stored upload buffer, driven by the SNIFFED format
 * (never the client mimetype — F2).
 *
 * JPEG (the overwhelming majority — phone photos and scanner exports) is scrubbed losslessly by
 * stripJpegMetadata: pixels untouched, archive quality fully preserved. The rarer formats are
 * re-encoded through sharp, which drops all metadata by default; PNG and TIFF re-encode losslessly
 * and WebP is kept lossless, so pixels are preserved there too. `.rotate()` bakes in any EXIF
 * orientation before the tag is discarded, so a scrubbed image never displays sideways.
 *
 * A `heic` here means a HEIC/HEIF that reached the strip un-converted (convertHeicToJpeg only
 * handles brands it recognises). Re-encoding it through sharp strips the metadata where libvips can
 * decode it (the production image); on a host whose sharp cannot decode HEIC this throws, and the
 * caller turns that into a rejected upload rather than a stored, unscrubbed original.
 */
export async function stripImageMetadata(buf: Buffer, type: SniffedImageType): Promise<Buffer> {
  if (type === 'jpeg') {
    try {
      return stripJpegMetadata(buf)
    } catch {
      // A structurally odd JPEG we can't safely walk: fall back to a guaranteed strip via
      // re-encode rather than store an unscrubbed original (fail closed). q95 keeps this rare
      // path visually near-lossless.
      return sharp(buf).rotate().jpeg({ quality: 95 }).toBuffer()
    }
  }
  const img = sharp(buf).rotate()
  switch (type) {
    case 'png':
      return img.png().toBuffer()
    case 'tiff':
      return img.tiff().toBuffer()
    case 'webp':
      return img.webp({ lossless: true }).toBuffer()
    case 'heic':
      return img.jpeg({ quality: 95 }).toBuffer()
  }
}
