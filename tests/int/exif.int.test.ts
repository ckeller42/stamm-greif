// Integration: real EXIF-on-upload prefill (spec P2.1-A) over the actual HTTP API. Needs the
// server running against the TEST database — same setup as invites.int.test.ts / heic.int.test.ts
// (see either's top-of-file comment).
//
// Fixture provenance: tests/fixtures/dia-exif.jpg is tests/fixtures/dia.jpg re-encoded with
// sharp's own `.withExif()` — probed directly first (see the PR/report for the probe
// transcript): sharp's `Exif` type only exposes IFD0-IFD3 (libexif's four-IFD numbering, where
// IFD2 = the Exif sub-IFD that actually holds DateTimeOriginal and IFD3 = the GPS IFD), not
// named keys like "ExifIFD"/"GPSInfoIFD" as a first guess assumed. Once IFD2/IFD3 were used,
// sharp wrote real, `exif-reader`-parseable DateTimeOriginal + GPS tags with no external tool
// needed — the exiftool-container fallback the task spec allowed for was not necessary.
// Generated once via:
//   sharp(dia.jpg).jpeg({quality:80}).withExif({
//     IFD0: { Make: 'Testkamera', Model: 'Dia-Scanner' },
//     IFD2: { DateTimeOriginal: '2015:07:04 12:30:00' },
//     IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '47/1 5/1 30/1',
//             GPSLongitudeRef: 'W', GPSLongitude: '8/1 30/1 15/1' },
//   }).toBuffer()
// 47°5'30" N / 8°30'15" W -> signed decimal 47.0916666... / -8.5041666...  (725 bytes).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getPayload, type Payload } from 'payload'
import config from '@payload-config'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

let payload: Payload
let memberEmail: string
let kuratorEmail: string
const password = 'geheim123'
const createdPhotoIds: number[] = []

const EXPECTED_LAT = 47 + 5 / 60 + 30 / 3600
const EXPECTED_LNG = -(8 + 30 / 60 + 15 / 3600)

beforeAll(async () => {
  payload = await getPayload({ config: await config })
  memberEmail = `exif-mitglied-${Date.now()}@example.com`
  kuratorEmail = `exif-kurator-${Date.now()}@example.com`
  await payload.create({
    collection: 'users',
    data: { name: 'Exif Test Mitglied', email: memberEmail, password, role: 'mitglied' },
    overrideAccess: true,
  })
  await payload.create({
    collection: 'users',
    data: { name: 'Exif Test Kurator', email: kuratorEmail, password, role: 'kurator' },
    overrideAccess: true,
  })
})

afterAll(async () => {
  if (createdPhotoIds.length) {
    await payload.delete({ collection: 'photos', where: { id: { in: createdPhotoIds } }, overrideAccess: true })
  }
})

async function loginCookie(email: string): Promise<string> {
  const res = await fetch('http://localhost:3000/api/users/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  expect(res.ok).toBe(true)
  return res.headers.get('set-cookie') ?? ''
}

async function uploadFixture(payloadFields: Record<string, unknown>) {
  const cookie = await loginCookie(memberEmail)
  const body = new FormData()
  const bytes = await readFile(path.resolve(process.cwd(), 'tests/fixtures/dia-exif.jpg'))
  body.append('file', new Blob([bytes], { type: 'image/jpeg' }), 'dia-exif.jpg')
  body.append('_payload', JSON.stringify({ _status: 'draft', ...payloadFields }))
  const res = await fetch('http://localhost:3000/api/photos', { method: 'POST', headers: { cookie }, body })
  return res
}

// Fix round 1 (M2): exifLat/exifLng are kurator/admin-only reads at the field-access level
// (own-upload status doesn't matter — this isn't a document-ownership check), so proving they
// were actually stored needs a re-fetch as a role that can see them.
async function fetchAsKurator(id: number): Promise<PhotoDoc> {
  const cookie = await loginCookie(kuratorEmail)
  const res = await fetch(`http://localhost:3000/api/photos/${id}`, { headers: { cookie } })
  expect(res.status).toBe(200)
  return (await res.json()) as PhotoDoc
}

interface PhotoDoc {
  id: number
  datePrecision?: string
  dateValue?: string | null
  exifTakenAt?: string | null
  exifLat?: number | null
  exifLng?: number | null
}

describe('EXIF-on-upload prefill', () => {
  it('unknown precision + no dateValue -> exact date prefilled from EXIF, raw capture fields stored', async () => {
    const res = await uploadFixture({ datePrecision: 'unknown' })
    const json = (await res.json()) as { doc?: PhotoDoc; errors?: { message: string }[] }
    expect(res.status, JSON.stringify(json.errors)).toBe(201)
    const id = json.doc?.id as number
    createdPhotoIds.push(id)
    const doc = json.doc as PhotoDoc

    expect(doc.datePrecision).toBe('exact')
    expect(doc.dateValue).toBe('2015-07-04')
    // exifTakenAt is open to any authenticated reader, including the mitglied who uploaded it.
    expect(doc.exifTakenAt).toBe('2015-07-04T12:30:00.000Z')
    // Fix round 1 (M2): exifLat/exifLng are kurator/admin-only — the uploader's own mitglied
    // response must NOT include them, even though it's their own upload (field access, not a
    // document-ownership check).
    expect(doc.exifLat).toBeUndefined()
    expect(doc.exifLng).toBeUndefined()

    const kuratorView = await fetchAsKurator(id)
    expect(kuratorView.exifLat).toBeCloseTo(EXPECTED_LAT, 4)
    expect(kuratorView.exifLng).toBeCloseTo(EXPECTED_LNG, 4)
  })

  it('user-provided year is kept as-is; EXIF fields are still stored alongside it', async () => {
    const res = await uploadFixture({ datePrecision: 'year', dateValue: '1975' })
    const json = (await res.json()) as { doc?: PhotoDoc; errors?: { message: string }[] }
    expect(res.status, JSON.stringify(json.errors)).toBe(201)
    const id = json.doc?.id as number
    createdPhotoIds.push(id)
    const doc = json.doc as PhotoDoc

    // Never overrides human input.
    expect(doc.datePrecision).toBe('year')
    expect(doc.dateValue).toBe('1975')
    // But the raw capture info is always recorded — it's new data nobody could have hand-entered.
    expect(doc.exifTakenAt).toBe('2015-07-04T12:30:00.000Z')
    expect(doc.exifLat).toBeUndefined()
    expect(doc.exifLng).toBeUndefined()

    const kuratorView = await fetchAsKurator(id)
    expect(kuratorView.exifLat).toBeCloseTo(EXPECTED_LAT, 4)
    expect(kuratorView.exifLng).toBeCloseTo(EXPECTED_LNG, 4)
  })
})
