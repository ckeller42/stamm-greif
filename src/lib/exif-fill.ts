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

// Fix round 1 (M3): on a PARTIAL update (e.g. a REST PATCH that re-uploads a file alongside a
// minimal `_payload` omitting datePrecision/dateValue entirely), Payload's incoming `data` only
// carries the fields that request actually sent — datePrecision/dateValue come through as
// `undefined`, not "unset". Resolving those against `originalDoc` first (same
// data-present-else-fall-back-to-existing-doc pattern Photos.ts's sibling beforeChange hook
// already uses for `people`) is what tells "nothing was ever set" (should fill) apart from
// "already has a curator-set date, this request just didn't touch it" (must not fill). Only
// meaningful for updates — `originalDoc` is undefined on create, where `data` alone is
// authoritative.
export function resolveIncomingDateFields(
  data: IncomingDateFields,
  originalDoc?: IncomingDateFields,
): IncomingDateFields {
  return {
    datePrecision: data.datePrecision !== undefined ? data.datePrecision : originalDoc?.datePrecision,
    dateValue: data.dateValue !== undefined ? data.dateValue : originalDoc?.dateValue,
  }
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
// is which of the two ref letters means "negate" for the axis being converted. `maxAbs` is the
// valid coordinate range for that axis (90 for latitude, 180 for longitude).
//
// Fix round 1 (L1): guards the RESULT, not just the raw `deg` input. exif-reader's rational
// reader (numerator/denominator) returns `Infinity`/`NaN` for a zero-denominator rational
// (`x/0`) rather than throwing — a malformed or adversarial EXIF blob could carry that in the
// minutes/seconds component even when `deg` alone looks fine, and an out-of-range-but-finite
// value (a corrupt tag, not just a divide-by-zero) is just as wrong. Either would otherwise
// survive silently all the way into a Postgres `numeric` column.
//
// CodeRabbit (PR #18): also validate each COMPONENT's own valid range, not just finiteness —
// EXIF's DMS encoding is degrees/minutes/seconds where the sign lives entirely in the ref
// (GPSLatitudeRef/GPSLongitudeRef), so `deg` itself is never negative, and minutes/seconds are
// each a sexagesimal component (`0 <= x < 60`) by definition. A negative minutes/seconds value
// (e.g. a corrupt or hand-crafted `[1, -30, 0]`) would previously still compute a plausible-
// looking, in-range final decimal — passing the earlier finite/range check while being
// structurally nonsense DMS input, not a real coordinate.
function dmsToSignedDecimal(
  dms: number[] | undefined,
  ref: string | undefined,
  negativeRef: string,
  maxAbs: number,
): number | undefined {
  if (!dms || dms.length === 0) return undefined
  const [deg, min = 0, sec = 0] = dms
  if (!Number.isFinite(deg) || !Number.isFinite(min) || !Number.isFinite(sec)) return undefined
  if (deg < 0 || min < 0 || min >= 60 || sec < 0 || sec >= 60) return undefined
  const decimal = deg + min / 60 + sec / 3600
  const signed = ref?.toUpperCase() === negativeRef ? -decimal : decimal
  if (!Number.isFinite(signed) || Math.abs(signed) > maxAbs) return undefined
  return signed
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

  const lat = dmsToSignedDecimal(exif.GPSInfo?.GPSLatitude, exif.GPSInfo?.GPSLatitudeRef, 'S', 90)
  if (lat !== undefined) fill.exifLat = lat
  const lng = dmsToSignedDecimal(exif.GPSInfo?.GPSLongitude, exif.GPSInfo?.GPSLongitudeRef, 'W', 180)
  if (lng !== undefined) fill.exifLng = lng

  return fill
}
