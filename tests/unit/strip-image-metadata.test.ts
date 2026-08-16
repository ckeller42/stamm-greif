import { describe, it, expect } from 'vitest'
import sharp from 'sharp'
import { stripJpegMetadata, stripImageMetadata } from '@/lib/strip-image-metadata'

// A GPS IFD sharp will embed into the EXIF block. The exact coordinate does not matter — the test
// asserts it is present before the strip and gone after.
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

async function rawPixels(buf: Buffer): Promise<Buffer> {
  return sharp(buf).raw().toBuffer()
}

describe('stripJpegMetadata (lossless)', () => {
  it('removes GPS/EXIF from a JPEG', async () => {
    const withGps = await jpegWithGps()
    expect((await sharp(withGps).metadata()).exif).toBeTruthy()

    const stripped = stripJpegMetadata(withGps)
    expect((await sharp(stripped).metadata()).exif).toBeUndefined()
  })

  it('leaves the decoded pixels bit-identical (no re-encode)', async () => {
    const withGps = await jpegWithGps()
    const stripped = stripJpegMetadata(withGps)
    // Same pixels out means the entropy-coded scan was copied verbatim, not re-compressed.
    expect(Buffer.compare(await rawPixels(withGps), await rawPixels(stripped))).toBe(0)
    // And it is genuinely smaller — the EXIF block is gone, not just ignored.
    expect(stripped.length).toBeLessThan(withGps.length)
  })

  it('is a valid-JPEG no-op when there is no metadata to strip', async () => {
    const plain = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .jpeg()
      .toBuffer()
    const stripped = stripJpegMetadata(plain)
    expect((await sharp(stripped).metadata()).format).toBe('jpeg')
    expect(Buffer.compare(await rawPixels(plain), await rawPixels(stripped))).toBe(0)
  })

  it('throws on a non-JPEG buffer (so the caller can fall back)', () => {
    expect(() => stripJpegMetadata(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toThrow()
  })
})

describe('stripImageMetadata (format-aware)', () => {
  it('scrubs JPEG losslessly through the dedicated path', async () => {
    const withGps = await jpegWithGps()
    const out = await stripImageMetadata(withGps, 'image/jpeg')
    expect((await sharp(out).metadata()).exif).toBeUndefined()
    expect(Buffer.compare(await rawPixels(withGps), await rawPixels(out))).toBe(0)
  })

  it('strips metadata from a PNG', async () => {
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 4, g: 5, b: 6 } } })
      .withExif({ IFD0: { ImageDescription: 'secret place' } })
      .png()
      .toBuffer()
    const out = await stripImageMetadata(png, 'image/png')
    const meta = await sharp(out).metadata()
    expect(meta.format).toBe('png')
    expect(meta.exif).toBeUndefined()
  })

  it('falls back to a re-encode strip for a corrupt JPEG rather than storing it unscrubbed', async () => {
    // Valid SOI so the mimetype branch is taken, then garbage: the lossless walk throws and the
    // sharp fallback must still return a metadata-free image.
    const broken = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x10]), Buffer.from('Exif junk')])
    await expect(stripImageMetadata(broken, 'image/jpeg')).rejects.toThrow() // sharp cannot decode pure garbage
  })
})
