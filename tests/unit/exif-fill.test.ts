import { describe, it, expect } from 'vitest'
import { computeExifFill, resolveIncomingDateFields, type ParsedExif } from '@/lib/exif-fill'

const exifWithDateAndGps: ParsedExif = {
  Photo: { DateTimeOriginal: new Date(Date.UTC(2015, 6, 4, 12, 30, 0)) },
  GPSInfo: {
    GPSLatitude: [47, 5, 30],
    GPSLatitudeRef: 'N',
    GPSLongitude: [8, 30, 15],
    GPSLongitudeRef: 'W',
  },
}

describe('computeExifFill', () => {
  it('no exif at all -> no fills', () => {
    expect(computeExifFill(undefined, { datePrecision: 'unknown', dateValue: null })).toEqual({})
  })

  it('exif present but no relevant tags -> no fills', () => {
    expect(computeExifFill({}, { datePrecision: 'unknown' })).toEqual({})
  })

  it('datePrecision unknown, no dateValue -> fills exact date + raw capture fields', () => {
    expect(computeExifFill(exifWithDateAndGps, { datePrecision: 'unknown', dateValue: null })).toEqual({
      datePrecision: 'exact',
      dateValue: '2015-07-04',
      exifTakenAt: '2015-07-04T12:30:00.000Z',
      exifLat: 47 + 5 / 60 + 30 / 3600,
      exifLng: -(8 + 30 / 60 + 15 / 3600),
    })
  })

  it('datePrecision absent entirely, no dateValue -> same as unknown', () => {
    const fill = computeExifFill(exifWithDateAndGps, {})
    expect(fill.datePrecision).toBe('exact')
    expect(fill.dateValue).toBe('2015-07-04')
  })

  it('user already set a year -> date fields untouched, raw capture fields still stored', () => {
    const fill = computeExifFill(exifWithDateAndGps, { datePrecision: 'year', dateValue: '1975' })
    expect(fill.datePrecision).toBeUndefined()
    expect(fill.dateValue).toBeUndefined()
    expect(fill.exifTakenAt).toBe('2015-07-04T12:30:00.000Z')
    expect(fill.exifLat).toBeCloseTo(47.09167, 4)
    expect(fill.exifLng).toBeCloseTo(-8.50417, 4)
  })

  it('user already set an exact date -> date fields untouched', () => {
    const fill = computeExifFill(exifWithDateAndGps, { datePrecision: 'exact', dateValue: '1999-01-01' })
    expect(fill.datePrecision).toBeUndefined()
    expect(fill.dateValue).toBeUndefined()
  })

  it('datePrecision unknown but user already typed a dateValue -> date fields untouched', () => {
    // Guards the "unknown selected, then free-typed a value before the select updates" edge case.
    const fill = computeExifFill(exifWithDateAndGps, { datePrecision: 'unknown', dateValue: '1980' })
    expect(fill.datePrecision).toBeUndefined()
    expect(fill.dateValue).toBeUndefined()
  })

  it('falls back to Image.DateTime when Photo.DateTimeOriginal is absent', () => {
    const exif: ParsedExif = { Image: { DateTime: new Date(Date.UTC(2001, 0, 1, 0, 0, 0)) } }
    const fill = computeExifFill(exif, { datePrecision: 'unknown' })
    expect(fill.exifTakenAt).toBe('2001-01-01T00:00:00.000Z')
    expect(fill.dateValue).toBe('2001-01-01')
  })

  it('falls back to Photo.DateTimeDigitized when neither DateTimeOriginal nor Image.DateTime is present', () => {
    const exif: ParsedExif = { Photo: { DateTimeDigitized: new Date(Date.UTC(2002, 5, 15, 0, 0, 0)) } }
    const fill = computeExifFill(exif, { datePrecision: 'unknown' })
    expect(fill.exifTakenAt).toBe('2002-06-15T00:00:00.000Z')
  })

  it('GPS south/east -> latitude negative, longitude positive', () => {
    const exif: ParsedExif = {
      GPSInfo: {
        GPSLatitude: [33, 51, 35.9],
        GPSLatitudeRef: 'S',
        GPSLongitude: [151, 12, 40],
        GPSLongitudeRef: 'E',
      },
    }
    const fill = computeExifFill(exif, {})
    expect(fill.exifLat).toBeLessThan(0)
    expect(fill.exifLng).toBeGreaterThan(0)
  })

  it('GPS ref lowercase is still respected (case-insensitive)', () => {
    const exif: ParsedExif = { GPSInfo: { GPSLatitude: [1, 0, 0], GPSLatitudeRef: 's' } }
    const fill = computeExifFill(exif, {})
    expect(fill.exifLat).toBe(-1)
  })

  it('missing GPS ref defaults to positive (no negation)', () => {
    const exif: ParsedExif = { GPSInfo: { GPSLatitude: [1, 0, 0] } }
    const fill = computeExifFill(exif, {})
    expect(fill.exifLat).toBe(1)
  })

  it('no capture date at all -> exifTakenAt absent, no date fields set even when incoming is unknown', () => {
    const fill = computeExifFill({ GPSInfo: { GPSLatitude: [1, 0, 0], GPSLatitudeRef: 'N' } }, { datePrecision: 'unknown' })
    expect(fill.exifTakenAt).toBeUndefined()
    expect(fill.datePrecision).toBeUndefined()
    expect(fill.dateValue).toBeUndefined()
    expect(fill.exifLat).toBe(1)
  })

  // Fix round 1 (L1): a zero-denominator rational (exiftool/exif-reader render `x/0` as
  // Infinity rather than throwing) must never survive into exifLat/exifLng.
  it('Infinity in the minutes component -> exifLat omitted, not Infinity', () => {
    const exif: ParsedExif = { GPSInfo: { GPSLatitude: [1, Infinity, 0], GPSLatitudeRef: 'N' } }
    const fill = computeExifFill(exif, {})
    expect(fill.exifLat).toBeUndefined()
  })

  it('NaN in the seconds component -> exifLng omitted', () => {
    const exif: ParsedExif = { GPSInfo: { GPSLongitude: [1, 0, NaN], GPSLongitudeRef: 'E' } }
    const fill = computeExifFill(exif, {})
    expect(fill.exifLng).toBeUndefined()
  })

  it('out-of-range but finite latitude (corrupt tag, deg > 90) -> omitted', () => {
    const exif: ParsedExif = { GPSInfo: { GPSLatitude: [200, 0, 0], GPSLatitudeRef: 'N' } }
    const fill = computeExifFill(exif, {})
    expect(fill.exifLat).toBeUndefined()
  })

  it('out-of-range but finite longitude (corrupt tag, deg > 180) -> omitted', () => {
    const exif: ParsedExif = { GPSInfo: { GPSLongitude: [200, 0, 0], GPSLongitudeRef: 'E' } }
    const fill = computeExifFill(exif, {})
    expect(fill.exifLng).toBeUndefined()
  })

  it('boundary values (exactly 90 / 180) are kept, not treated as out-of-range', () => {
    const exif: ParsedExif = {
      GPSInfo: { GPSLatitude: [90, 0, 0], GPSLatitudeRef: 'N', GPSLongitude: [180, 0, 0], GPSLongitudeRef: 'E' },
    }
    const fill = computeExifFill(exif, {})
    expect(fill.exifLat).toBe(90)
    expect(fill.exifLng).toBe(180)
  })
})

describe('resolveIncomingDateFields', () => {
  it('create with nothing set -> passes through as unknown/empty (fill applies downstream)', () => {
    expect(resolveIncomingDateFields({ datePrecision: 'unknown' })).toEqual({
      datePrecision: 'unknown',
      dateValue: undefined,
    })
  })

  it('partial update omitting both fields falls back to originalDoc (a decade date) -> no fill', () => {
    const resolved = resolveIncomingDateFields({}, { datePrecision: 'decade', dateValue: '1980' })
    expect(resolved).toEqual({ datePrecision: 'decade', dateValue: '1980' })
    // Feeding this straight into computeExifFill proves the end-to-end "must not fill" outcome.
    const fill = computeExifFill(exifWithDateAndGps, resolved)
    expect(fill.datePrecision).toBeUndefined()
    expect(fill.dateValue).toBeUndefined()
  })

  it('partial update that DOES send datePrecision (even null) wins over originalDoc', () => {
    // data.datePrecision explicitly present (not undefined) — even as null/'unknown' — must not
    // fall back to originalDoc; that would ignore a genuine "user cleared it" request.
    const resolved = resolveIncomingDateFields({ datePrecision: 'unknown' }, { datePrecision: 'decade', dateValue: '1980' })
    expect(resolved.datePrecision).toBe('unknown')
  })

  it('no originalDoc (create) -> undefined fields stay undefined, not thrown on', () => {
    expect(resolveIncomingDateFields({})).toEqual({ datePrecision: undefined, dateValue: undefined })
  })
})
