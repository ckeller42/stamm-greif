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

async function uploadFile(
  fixtureFile: string,
  payloadFields: Record<string, unknown>,
  spoof?: { contentType: string; filename: string },
) {
  const cookie = await loginCookie(memberEmail)
  const body = new FormData()
  const bytes = await readFile(path.resolve(process.cwd(), 'tests/fixtures', fixtureFile))
  body.append(
    'file',
    new Blob([bytes], { type: spoof?.contentType ?? 'image/jpeg' }),
    spoof?.filename ?? fixtureFile,
  )
  body.append('_payload', JSON.stringify({ _status: 'draft', ...payloadFields }))
  const res = await fetch('http://localhost:3000/api/photos', { method: 'POST', headers: { cookie }, body })
  return res
}

async function uploadFixture(payloadFields: Record<string, unknown>) {
  return uploadFile('dia-exif.jpg', payloadFields)
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
  filename?: string | null
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

  it('CodeRabbit (PR #18): a spoofed exifLat/exifLng/exifTakenAt in _payload is dropped, not stored', async () => {
    // tests/fixtures/dia.jpg carries no EXIF at all (verified directly: sharp's own
    // metadata().exif is undefined for it) — so applyExifFill never touches these fields on this
    // upload, and the ONLY way they could end up populated is if a client's own directly-
    // submitted `_payload` values were accepted. `access: { create: () => false, update: () =>
    // false }` (Photos.ts) is what's meant to strip those before they ever reach storage.
    const res = await uploadFile('dia.jpg', {
      datePrecision: 'unknown',
      exifLat: 12.3456,
      exifLng: 65.4321,
      exifTakenAt: '1999-01-01T00:00:00.000Z',
    })
    const json = (await res.json()) as { doc?: PhotoDoc; errors?: { message: string }[] }
    expect(res.status, JSON.stringify(json.errors)).toBe(201)
    const id = json.doc?.id as number
    createdPhotoIds.push(id)

    // A kurator re-fetch (not the mitglied uploader's own response) is the real proof here:
    // exifLat/exifLng are field-access-hidden from a mitglied's own response regardless of
    // whether they were ever stored (fix round 1, M2) — a kurator CAN see them, so a kurator
    // response showing them null/absent proves the spoofed values were actually dropped
    // server-side, not merely hidden from this particular reader.
    const kuratorView = await fetchAsKurator(id)
    expect(kuratorView.exifLat).toBeFalsy()
    expect(kuratorView.exifLng).toBeFalsy()
    expect(kuratorView.exifTakenAt).toBeFalsy()
  })

  // Consent audit C1: the GPS coordinate must be read into the (kurator-only) exifLat/exifLng DB
  // fields AND scrubbed from the STORED original file. The original blob is what the anonymous
  // kiosk download route and Payload's /api/photos/file/:filename stream — neither passes through
  // field access — so a coordinate left in the file bytes leaks a member's/child's home location.
  it('scrubs GPS EXIF from the stored original while keeping the coordinate in the kurator-only fields', async () => {
    const { default: sharp } = await import('sharp')
    // Sanity-check the fixture itself really carries GPS EXIF before upload.
    const fixtureBytes = await readFile(path.resolve(process.cwd(), 'tests/fixtures', 'dia-exif.jpg'))
    expect((await sharp(fixtureBytes).metadata()).exif).toBeTruthy()

    const res = await uploadFixture({ datePrecision: 'unknown' })
    const json = (await res.json()) as { doc?: PhotoDoc; errors?: { message: string }[] }
    expect(res.status, JSON.stringify(json.errors)).toBe(201)
    const id = json.doc?.id as number
    createdPhotoIds.push(id)

    // The coordinate is preserved for curators via the DB fields...
    const kuratorView = await fetchAsKurator(id)
    expect(kuratorView.exifLat).toBeCloseTo(EXPECTED_LAT, 4)
    expect(kuratorView.exifLng).toBeCloseTo(EXPECTED_LNG, 4)

    // ...but the stored original file on disk has NO EXIF left at all.
    const filename = kuratorView.filename as string
    expect(filename).toBeTruthy()
    const storedBytes = await readFile(path.resolve(process.cwd(), 'photos', filename))
    const storedMeta = await sharp(storedBytes).metadata()
    expect(storedMeta.exif).toBeUndefined()
    // And the scrub was lossless — same decoded pixels as the fixture (no re-encode).
    const [origPixels, storedPixels] = await Promise.all([
      sharp(fixtureBytes).raw().toBuffer(),
      sharp(storedBytes).raw().toBuffer(),
    ])
    expect(Buffer.compare(origPixels, storedPixels)).toBe(0)
  })

  // Consent audit C1/F2: the scrub must key off the SNIFFED format, not the client-declared
  // mimetype. A member could upload real JPEG-with-GPS bytes labelled image/heic (filename .heic);
  // the HEIC converter no-ops (bytes aren't HEIC) and Payload sniff-accepts them as JPEG. The
  // stored original must still be scrubbed.
  it('scrubs a JPEG-with-GPS even when uploaded spoofed as image/heic', async () => {
    const { default: sharp } = await import('sharp')
    const res = await uploadFile('dia-exif.jpg', { datePrecision: 'unknown' }, {
      contentType: 'image/heic',
      filename: 'spoof.heic',
    })
    const json = (await res.json()) as { doc?: PhotoDoc; errors?: { message: string }[] }
    expect(res.status, JSON.stringify(json.errors)).toBe(201)
    const id = json.doc?.id as number
    createdPhotoIds.push(id)

    const kuratorView = await fetchAsKurator(id)
    const filename = kuratorView.filename as string
    const storedBytes = await readFile(path.resolve(process.cwd(), 'photos', filename))
    expect((await sharp(storedBytes).metadata()).exif).toBeUndefined()
    // Byte-level: no EXIF APP1 identifier anywhere in the stored original.
    expect(storedBytes.includes(Buffer.from('Exif\0\0', 'latin1'))).toBe(false)
  })
})
