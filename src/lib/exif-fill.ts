// Pure decision logic for EXIF-on-upload prefill (spec P2.1-A). Kept free of any `sharp` /
// `exif-reader` import so it stays trivially unit-testable — Photos.ts is the only place that
// touches the actual parsing library; this module just decides what to do with the result.
//
// Shape mirrors (a subset of) exif-reader's `Exif` return type structurally, not by import —
// avoids coupling this pure module to that package's types, and this is all photo EXIF ever
// needs from three of its dozens of tags.
export interface ParsedExif {
  Photo?: {
    DateTimeOriginal?: Date
    DateTimeDigitized?: Date
  }
  Image?: {
    DateTime?: Date
  }
  GPSInfo?: {
    GPSLatitude?: number[]
    GPSLatitudeRef?: string
    GPSLongitude?: number[]
    GPSLongitudeRef?: string
  }
}

export interface IncomingDateFields {
  datePrecision?: string | null
  dateValue?: string | null
}

export interface ExifFill {
  datePrecision?: 'exact'
  dateValue?: string
  exifTakenAt?: string
  exifLat?: number
  exifLng?: number
}

function isValidDate(d: unknown): d is Date {
  return d instanceof Date && !Number.isNaN(d.getTime())
}

// EXIF GPS coordinates are stored as unsigned degrees/minutes/seconds plus a hemisphere ref
// ('N'/'S' for latitude, 'E'/'W' for longitude) — the ref alone carries the sign. `negativeRef`
// is which of the two ref letters means "negate" for the axis being converted.
function dmsToSignedDecimal(dms: number[] | undefined, ref: string | undefined, negativeRef: string): number | undefined {
  if (!dms || dms.length === 0) return undefined
  const [deg, min = 0, sec = 0] = dms
  if (!Number.isFinite(deg)) return undefined
  const decimal = deg + min / 60 + sec / 3600
  return ref?.toUpperCase() === negativeRef ? -decimal : decimal
}

// NEVER overrides human input. `exifTakenAt`/`exifLat`/`exifLng` (raw capture info, powers a
// future map view) are always filled when present in the EXIF — those are new fields nobody
// could have hand-entered yet. `datePrecision`/`dateValue` (the fuzzy-date fields a volunteer
// may already have typed in) are only filled when the incoming data shows no human input at
// all: precision absent or 'unknown', and no dateValue text either.
export function computeExifFill(exif: ParsedExif | undefined, incoming: IncomingDateFields): ExifFill {
  const fill: ExifFill = {}
  if (!exif) return fill

  const takenAt = [exif.Photo?.DateTimeOriginal, exif.Image?.DateTime, exif.Photo?.DateTimeDigitized].find(
    isValidDate,
  )
  if (takenAt) {
    fill.exifTakenAt = takenAt.toISOString()

    const hasHumanDate = (incoming.datePrecision && incoming.datePrecision !== 'unknown') || Boolean(incoming.dateValue)
    if (!hasHumanDate) {
      fill.datePrecision = 'exact'
      const y = takenAt.getUTCFullYear()
      const m = String(takenAt.getUTCMonth() + 1).padStart(2, '0')
      const d = String(takenAt.getUTCDate()).padStart(2, '0')
      fill.dateValue = `${y}-${m}-${d}`
    }
  }

  const lat = dmsToSignedDecimal(exif.GPSInfo?.GPSLatitude, exif.GPSInfo?.GPSLatitudeRef, 'S')
  if (lat !== undefined) fill.exifLat = lat
  const lng = dmsToSignedDecimal(exif.GPSInfo?.GPSLongitude, exif.GPSInfo?.GPSLongitudeRef, 'W')
  if (lng !== undefined) fill.exifLng = lng

  return fill
}
