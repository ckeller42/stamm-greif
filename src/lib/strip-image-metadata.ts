import sharp from 'sharp'

// P2 consent audit, C1: the kurator-only `exifLat`/`exifLng` FIELDS gate who can read a photo's
// coordinates through the document API — but the stored ORIGINAL file still carries the same GPS
// inside its EXIF, and two paths stream that original blob to callers who never pass through
// field access: the anonymous kiosk download route and Payload's own /api/photos/file/:filename.
// So the coordinate must be removed from the file bytes themselves at upload. It is preserved for
// curators regardless — extractExifOnUpload reads it into the DB fields BEFORE this strip runs.

// JPEG markers that carry no 2-byte length field (standalone) in the pre-scan header region.
const STANDALONE_MARKERS = new Set([0xd8, 0xd9, 0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7])

// APPn segments dropped because they can carry location/identity metadata:
//   APP1 (0xE1): EXIF (including the GPS IFD) and XMP
//   APP13 (0xED): Photoshop Image Resource Block / IPTC (can also carry a location)
// Everything else — APP0/JFIF, APP2/ICC colour profile, the quantization and Huffman tables, the
// frame header and the entropy-coded scan — is copied through byte-for-byte, so the DECODED pixels
// are bit-identical to the original. This is a metadata scrub, not a re-encode.
const DROP_APP_MARKERS = new Set([0xe1, 0xed])

/**
 * Losslessly remove the metadata segments that can hold location/identity data from a JPEG,
 * without decoding or re-encoding the image. Returns the scrubbed buffer.
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

    if (marker === 0xda) {
      // Start of Scan: copy its header and ALL remaining entropy-coded data (up to EOI) verbatim.
      out.push(buf.subarray(markerStart))
      return Buffer.concat(out)
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
    if (!DROP_APP_MARKERS.has(marker)) {
      out.push(buf.subarray(markerStart, segEnd))
    }
    i = segEnd
  }
  // Reached the end without hitting a scan — unusual but not fatal; return what we assembled.
  return Buffer.concat(out)
}

/**
 * Remove location/identity metadata from a stored upload buffer, format-aware.
 *
 * JPEG (the overwhelming majority — phone photos and scanner exports) is scrubbed losslessly by
 * stripJpegMetadata: pixels untouched, archive quality fully preserved. The rarer formats are
 * re-encoded through sharp, which drops all metadata by default; PNG and TIFF re-encode losslessly
 * and WebP is kept lossless, so pixels are preserved there too. `.rotate()` bakes in any EXIF
 * orientation before the tag is discarded, so a scrubbed image never displays sideways.
 *
 * HEIC/HEIF never reaches here carrying EXIF: convertHeicToJpeg (which runs first) already
 * re-encoded it to a metadata-free JPEG, so this sees clean JPEG bytes and no-ops on them.
 */
export async function stripImageMetadata(buf: Buffer, mimetype: string): Promise<Buffer> {
  if (mimetype === 'image/jpeg') {
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
  switch (mimetype) {
    case 'image/png':
      return img.png().toBuffer()
    case 'image/tiff':
      return img.tiff().toBuffer()
    case 'image/webp':
      return img.webp({ lossless: true }).toBuffer()
    default:
      // Unknown raster type that still passed upload validation: strip via a JPEG re-encode.
      return img.jpeg({ quality: 95 }).toBuffer()
  }
}
