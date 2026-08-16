import { describe, it, expect } from 'vitest'
import sharp from 'sharp'
import { stripJpegMetadata, stripImageMetadata, detectImageType } from '@/lib/strip-image-metadata'

// A GPS IFD sharp will embed into the EXIF block. The exact coordinate does not matter — the tests
// assert it is present before the strip and gone after.
const GPS_EXIF = {
  IFD0: { Copyright: 'Greif' },
  GPS: { GPSLatitudeRef: 'N', GPSLatitude: '48/1 0/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '11/1 0/1 0/1' },
} as const

async function jpegWithGps(): Promise<Buffer> {
  return sharp({ create: { width: 16, height: 12, channels: 3, background: { r: 10, g: 120, b: 200 } } })
    .withExif(GPS_EXIF)
    .jpeg({ quality: 92 })
    .toBuffer()
}

async function plainJpeg(w = 8, h = 8): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: { r: 1, g: 2, b: 3 } } }).jpeg().toBuffer()
}

async function rawPixels(buf: Buffer): Promise<Buffer> {
  return sharp(buf).raw().toBuffer()
}

// How many complete JPEGs (SOI markers) the buffer contains, and whether an 'Exif' APP1 identifier
// appears anywhere — a byte-level check, because sharp().metadata().exif only ever reads the FIRST
// image's IFD and is blind to metadata in an appended image (the F1 trap).
function soiCount(buf: Buffer): number {
  let n = 0
  for (let i = 0; i + 1 < buf.length; i++) if (buf[i] === 0xff && buf[i + 1] === 0xd8) n++
  return n
}
function containsExifMarker(buf: Buffer): boolean {
  return buf.includes(Buffer.from('Exif\0\0', 'latin1'))
}

describe('detectImageType (magic-byte sniff, ignores label)', () => {
  it('sniffs real formats from bytes', async () => {
    expect(detectImageType(await jpegWithGps())).toBe('jpeg')
    expect(detectImageType(await sharp({ create: { width: 4, height: 4, channels: 3, background: '#000' } }).png().toBuffer())).toBe('png')
    expect(detectImageType(await sharp({ create: { width: 4, height: 4, channels: 3, background: '#000' } }).webp().toBuffer())).toBe('webp')
    expect(detectImageType(await sharp({ create: { width: 4, height: 4, channels: 3, background: '#000' } }).tiff().toBuffer())).toBe('tiff')
  })

  it('detects a HEIC/HEIF ftyp box by brand', () => {
    // Minimal ISOBMFF header: box size, 'ftyp', major brand 'heic'.
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic', 'latin1'), Buffer.alloc(16)])
    expect(detectImageType(heic)).toBe('heic')
    const hevc = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftyphevc', 'latin1'), Buffer.alloc(16)])
    expect(detectImageType(hevc)).toBe('heic')
  })

  it('returns null for a non-image (so Payload owns the rejection)', () => {
    expect(detectImageType(Buffer.from('GIF89a and then some bytes here'))).toBeNull()
    expect(detectImageType(Buffer.from('hello world not an image!!'))).toBeNull()
  })
})

describe('stripJpegMetadata (lossless)', () => {
  it('removes GPS/EXIF from a JPEG', async () => {
    const withGps = await jpegWithGps()
    expect((await sharp(withGps).metadata()).exif).toBeTruthy()
    const stripped = stripJpegMetadata(withGps)
    expect((await sharp(stripped).metadata()).exif).toBeUndefined()
    expect(containsExifMarker(stripped)).toBe(false)
  })

  it('leaves the decoded pixels bit-identical (no re-encode)', async () => {
    const withGps = await jpegWithGps()
    const stripped = stripJpegMetadata(withGps)
    expect(Buffer.compare(await rawPixels(withGps), await rawPixels(stripped))).toBe(0)
    expect(stripped.length).toBeLessThan(withGps.length)
  })

  it('preserves an ICC colour profile (APP2) while dropping EXIF', async () => {
    // A JPEG carrying both an ICC profile and GPS EXIF.
    const withIcc = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 9, g: 9, b: 9 } } })
      .withMetadata({ icc: 'srgb' })
      .withExif(GPS_EXIF)
      .jpeg()
      .toBuffer()
    const stripped = stripJpegMetadata(withIcc)
    const meta = await sharp(stripped).metadata()
    expect(meta.exif).toBeUndefined()
    expect(meta.icc).toBeTruthy() // colour profile survives
  })

  it('handles a progressive JPEG (multiple scans) without corruption', async () => {
    const prog = await sharp({ create: { width: 24, height: 24, channels: 3, background: { r: 40, g: 80, b: 160 } } })
      .withExif(GPS_EXIF)
      .jpeg({ progressive: true })
      .toBuffer()
    const stripped = stripJpegMetadata(prog)
    expect((await sharp(stripped).metadata()).exif).toBeUndefined()
    expect(Buffer.compare(await rawPixels(prog), await rawPixels(stripped))).toBe(0)
  })

  // F1: iPhone MPF / Samsung motion-photo style — a second full JPEG (with its OWN GPS) appended
  // after the primary image's EOI. The scrub must discard the trailer entirely.
  it('discards an appended second image and its GPS (multi-image JPEG)', async () => {
    const primary = await plainJpeg(16, 16)
    const secondaryWithGps = await jpegWithGps()
    const dual = Buffer.concat([primary, secondaryWithGps])
    // Sanity: the concatenated input really has two images and an Exif marker (from the secondary).
    expect(soiCount(dual)).toBe(2)
    expect(containsExifMarker(dual)).toBe(true)

    const stripped = stripJpegMetadata(dual)
    // Only the primary image survives, and no EXIF marker remains anywhere in the bytes.
    expect(soiCount(stripped)).toBe(1)
    expect(containsExifMarker(stripped)).toBe(false)
    // The surviving image is the primary, pixel-identical.
    expect(Buffer.compare(await rawPixels(primary), await rawPixels(stripped))).toBe(0)
    // It is a valid, complete JPEG ending in EOI.
    expect(stripped[stripped.length - 2]).toBe(0xff)
    expect(stripped[stripped.length - 1]).toBe(0xd9)
  })

  it('is a valid-JPEG no-op when there is no metadata to strip', async () => {
    const plain = await plainJpeg()
    const stripped = stripJpegMetadata(plain)
    expect((await sharp(stripped).metadata()).format).toBe('jpeg')
    expect(Buffer.compare(await rawPixels(plain), await rawPixels(stripped))).toBe(0)
  })

  it('throws on a non-JPEG buffer (so the caller can fall back)', () => {
    expect(() => stripJpegMetadata(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toThrow()
  })
})

describe('stripImageMetadata (format-aware, sniffed type)', () => {
  it('scrubs JPEG losslessly through the dedicated path', async () => {
    const withGps = await jpegWithGps()
    const out = await stripImageMetadata(withGps, 'jpeg')
    expect((await sharp(out).metadata()).exif).toBeUndefined()
    expect(Buffer.compare(await rawPixels(withGps), await rawPixels(out))).toBe(0)
  })

  it('strips metadata from a PNG', async () => {
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 4, g: 5, b: 6 } } })
      .withExif({ IFD0: { ImageDescription: 'secret place' } })
      .png()
      .toBuffer()
    const out = await stripImageMetadata(png, 'png')
    const meta = await sharp(out).metadata()
    expect(meta.format).toBe('png')
    expect(meta.exif).toBeUndefined()
  })

  it('falls back to a re-encode strip for a structurally-broken JPEG rather than storing it unscrubbed', async () => {
    const broken = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x10]), Buffer.from('Exif junk')])
    await expect(stripImageMetadata(broken, 'jpeg')).rejects.toThrow() // sharp cannot decode pure garbage
  })
})
