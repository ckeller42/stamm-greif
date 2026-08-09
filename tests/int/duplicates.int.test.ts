// Integration: duplicate-photo detection via perceptual hash (spec P2.2) over the actual HTTP
// API. Needs the server running against the TEST database — same setup as exif.int.test.ts /
// heic.int.test.ts (see either's top-of-file comment).
//
// Fixture provenance: three JPEGs are generated in-process via sharp, NOT taken from
// tests/fixtures/dia.jpg. This is a deliberate deviation from the task's literal fixture
// suggestion, found necessary while probing real hash values (throwaway
// scripts/.tmp-probe-phash.ts, deleted after use, not committed): dia.jpg is reused, unguarded,
// by several OTHER int test files (e.g. hidden-person.int.test.ts) that never clean up their
// created photos afterAll — so by the time this file's tests run, the test DB can already
// contain an arbitrary number of leftover dia.jpg-derived photos with a phash matching (or very
// close to) dia.jpg's own hash. Uploading dia.jpg itself as "fixture A" would then risk a false
// positive on the very first "no flag" assertion, entirely dependent on which other test files
// happened to run first and how many times the suite had previously been run against this
// (persistent) test DB. A base image built from `crypto.randomBytes(72)` — expanded to a real
// 100x100 JPEG via sharp, matching the actual 9x8-downsample granularity the dHash algorithm
// itself operates on — is astronomically unlikely to collide with anything already in the table
// (probability of landing within the 8-bit duplicate-threshold radius of any *fixed* existing
// hash by chance is on the order of 1e-10) while remaining fully deterministic in its OWN
// pairwise relationships to the two images derived from it below.
//
// Probe transcript (5 runs, confirming the approach before writing the test): recompressing the
// base image at a different JPEG quality (simulating a rescanned/re-exported duplicate)
// consistently produced hamming distance 0-1 from the original; negate() + rotate(180) (the
// "clearly different" fixture) consistently produced distance 27-41 — comfortably on either side
// of the DUPLICATE_HAMMING_THRESHOLD = 8 in src/collections/Photos.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getPayload, type Payload } from 'payload'
import config from '@payload-config'
import sharp from 'sharp'
import crypto from 'node:crypto'

let payload: Payload
let memberEmail: string
let otherMemberEmail: string
let kuratorEmail: string
const password = 'geheim123'
const createdPhotoIds: number[] = []

// Base 9x8 grayscale grid, expanded (nearest-neighbor, so no inter-pixel blending) to a real
// 100x100 JPEG — real enough to go through the app's actual upload pipeline (HEIC-conversion
// check, EXIF extraction, sharp re-encode for imageSizes, ...), but with pixel content built at
// exactly the granularity computeDHash's 9x8 downsample re-derives.
async function buildBaseJpeg(): Promise<Buffer> {
  const raw9x8 = crypto.randomBytes(72)
  return sharp(raw9x8, { raw: { width: 9, height: 8, channels: 1 } })
    .resize(100, 100, { kernel: 'nearest' })
    .jpeg({ quality: 90 })
    .toBuffer()
}

// m2 regression fixture: a genuinely flat/solid-color 100x100 JPEG. Per phash.test.ts's own
// pinned property, ANY flat color hashes to the same degenerate '0000000000000000' value — so
// two flat images of DIFFERENT colors are exactly the pair that would have been (wrongly)
// flagged as duplicates of each other before the isDegenerateHash guard existed.
async function buildFlatJpeg(background: { r: number; g: number; b: number }): Promise<Buffer> {
  return sharp({ create: { width: 100, height: 100, channels: 3, background } }).jpeg({ quality: 90 }).toBuffer()
}

beforeAll(async () => {
  payload = await getPayload({ config: await config })
  memberEmail = `dup-mitglied-${Date.now()}@example.com`
  otherMemberEmail = `dup-other-mitglied-${Date.now()}@example.com`
  kuratorEmail = `dup-kurator-${Date.now()}@example.com`
  await payload.create({
    collection: 'users',
    data: { name: 'Duplikat Test Mitglied', email: memberEmail, password, role: 'mitglied' },
    overrideAccess: true,
  })
  await payload.create({
    collection: 'users',
    data: { name: 'Duplikat Test Anderes Mitglied', email: otherMemberEmail, password, role: 'mitglied' },
    overrideAccess: true,
  })
  await payload.create({
    collection: 'users',
    data: { name: 'Duplikat Test Kurator', email: kuratorEmail, password, role: 'kurator' },
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

async function uploadBuffer(bytes: Buffer, filename: string) {
  const cookie = await loginCookie(memberEmail)
  const body = new FormData()
  body.append('file', new Blob([bytes], { type: 'image/jpeg' }), filename)
  body.append('_payload', JSON.stringify({ _status: 'draft', datePrecision: 'unknown' }))
  const res = await fetch('http://localhost:3000/api/photos', { method: 'POST', headers: { cookie }, body })
  return res
}

async function fetchAsUser(email: string, id: number): Promise<PhotoDoc> {
  const cookie = await loginCookie(email)
  const res = await fetch(`http://localhost:3000/api/photos/${id}`, { headers: { cookie } })
  expect(res.status).toBe(200)
  return (await res.json()) as PhotoDoc
}

async function fetchAsKurator(id: number): Promise<PhotoDoc> {
  return fetchAsUser(kuratorEmail, id)
}

interface PhotoDoc {
  id: number
  phash?: string
  duplicateOf?: number | { id: number } | null
  duplicateSuspected?: boolean
  uploader?: number | { id: number }
}

describe('duplicate detection on upload (P2.2)', () => {
  let baseJpeg: Buffer
  let firstUploadId: number

  it('first upload of a novel image: not flagged as a duplicate', async () => {
    baseJpeg = await buildBaseJpeg()
    const res = await uploadBuffer(baseJpeg, 'dup-a.jpg')
    const json = (await res.json()) as { doc?: PhotoDoc; errors?: { message: string }[] }
    expect(res.status, JSON.stringify(json.errors)).toBe(201)
    const doc = json.doc as PhotoDoc
    firstUploadId = doc.id
    createdPhotoIds.push(doc.id)

    // duplicateSuspected is readable by kurator/admin OR the photo's own uploader (M1 hardening
    // — see canReadDuplicateSuspected in Photos.ts); this response IS the uploader's own, so it's
    // visible here. The "a DIFFERENT mitglied can't see it" half is covered separately below in
    // the dedicated 'duplicateSuspected field access (M1)' describe block.
    expect(doc.duplicateSuspected).toBe(false)
    // duplicateOf is a relationship, kurator/admin read-only (existence-leak mitigation) — must
    // not appear at all in the mitglied's own response.
    expect(doc.duplicateOf).toBeUndefined()

    const kuratorView = await fetchAsKurator(doc.id)
    expect(kuratorView.duplicateSuspected).toBe(false)
    expect(kuratorView.duplicateOf).toBeFalsy()
  })

  it('re-uploading the same slide (recompressed, as a rescan/re-export would be): flagged, not blocked', async () => {
    const rescanned = await sharp(baseJpeg).jpeg({ quality: 60 }).toBuffer()
    const res = await uploadBuffer(rescanned, 'dup-a-rescan.jpg')
    const json = (await res.json()) as { doc?: PhotoDoc; errors?: { message: string }[] }
    // Never hard-blocked — a 201, not a 4xx, is itself part of the assertion.
    expect(res.status, JSON.stringify(json.errors)).toBe(201)
    const doc = json.doc as PhotoDoc
    createdPhotoIds.push(doc.id)

    expect(doc.duplicateSuspected).toBe(true)
    // Mitglied's own create response: duplicateSuspected present and true, duplicateOf absent —
    // exactly the split the consent-mitigation design calls for.
    expect(doc.duplicateOf).toBeUndefined()

    const kuratorView = await fetchAsKurator(doc.id)
    expect(kuratorView.duplicateSuspected).toBe(true)
    const kuratorDuplicateOf = kuratorView.duplicateOf
    const pointedId =
      typeof kuratorDuplicateOf === 'object' && kuratorDuplicateOf !== null
        ? kuratorDuplicateOf.id
        : kuratorDuplicateOf
    expect(pointedId).toBe(firstUploadId)
  })

  it('a clearly different photo (inverted + rotated): not flagged', async () => {
    const different = await sharp(baseJpeg).negate().rotate(180).jpeg({ quality: 90 }).toBuffer()
    const res = await uploadBuffer(different, 'dup-different.jpg')
    const json = (await res.json()) as { doc?: PhotoDoc; errors?: { message: string }[] }
    expect(res.status, JSON.stringify(json.errors)).toBe(201)
    const doc = json.doc as PhotoDoc
    createdPhotoIds.push(doc.id)

    expect(doc.duplicateSuspected).toBe(false)
    expect(doc.duplicateOf).toBeUndefined()

    const kuratorView = await fetchAsKurator(doc.id)
    expect(kuratorView.duplicateSuspected).toBe(false)
    expect(kuratorView.duplicateOf).toBeFalsy()
  })
})

// M1 hardening (review): duplicateSuspected is readable by kurator/admin OR the photo's own
// uploader — never by some OTHER mitglied. Needs a photo readable at the collection-access level
// by a mitglied who is NOT its uploader, which (per Photos.ts's canReadPhoto) means the photo
// must be published — a draft is only visible to its own uploader (or a kurator/admin) at the
// collection-access level regardless of any field-level rule, so testing "a different mitglied
// can read the photo but not this one field" needs to get past that gate first.
describe('duplicateSuspected field access (M1)', () => {
  it('uploader sees it, kurator sees it, a DIFFERENT mitglied does not', async () => {
    const jpeg = await buildBaseJpeg()
    const res = await uploadBuffer(jpeg, 'dup-field-access.jpg')
    const json = (await res.json()) as { doc?: PhotoDoc; errors?: { message: string }[] }
    expect(res.status, JSON.stringify(json.errors)).toBe(201)
    const doc = json.doc as PhotoDoc
    createdPhotoIds.push(doc.id)
    // The create response is the uploader's own — proves the field-access change didn't break
    // the exact path UploadForm.tsx's uploadOne() depends on for the warning to work at all.
    expect(typeof doc.duplicateSuspected).toBe('boolean')

    // Publish it (kurator/admin action) so a DIFFERENT mitglied can read the photo at all.
    await payload.update({
      collection: 'photos', id: doc.id, data: { _status: 'published' }, overrideAccess: true,
    })

    const ownUploaderView = await fetchAsUser(memberEmail, doc.id)
    expect(typeof ownUploaderView.duplicateSuspected).toBe('boolean')

    const kuratorView = await fetchAsUser(kuratorEmail, doc.id)
    expect(typeof kuratorView.duplicateSuspected).toBe('boolean')

    const otherMemberView = await fetchAsUser(otherMemberEmail, doc.id)
    // The photo itself IS readable (published, no hidden person) — id present proves that — but
    // duplicateSuspected specifically must be absent from this reader's response.
    expect(otherMemberView.id).toBe(doc.id)
    expect(otherMemberView.duplicateSuspected).toBeUndefined()
  })
})

// m2 (review): a degenerate hash (flat/solid-color images all collapse to the same
// '0000000000000000' dHash — see phash.test.ts) must never be compared, in either direction.
// Without the isDegenerateHash guard, these two images — genuinely unrelated, different colors —
// would hash identically and get (wrongly) flagged as duplicates of each other.
describe('degenerate hashes carry no evidence (m2)', () => {
  it('two flat/solid-color images of different colors: neither is flagged', async () => {
    const black = await buildFlatJpeg({ r: 0, g: 0, b: 0 })
    const white = await buildFlatJpeg({ r: 255, g: 255, b: 255 })

    const blackRes = await uploadBuffer(black, 'dup-flat-black.jpg')
    const blackJson = (await blackRes.json()) as { doc?: PhotoDoc; errors?: { message: string }[] }
    expect(blackRes.status, JSON.stringify(blackJson.errors)).toBe(201)
    const blackDoc = blackJson.doc as PhotoDoc
    createdPhotoIds.push(blackDoc.id)

    const whiteRes = await uploadBuffer(white, 'dup-flat-white.jpg')
    const whiteJson = (await whiteRes.json()) as { doc?: PhotoDoc; errors?: { message: string }[] }
    expect(whiteRes.status, JSON.stringify(whiteJson.errors)).toBe(201)
    const whiteDoc = whiteJson.doc as PhotoDoc
    createdPhotoIds.push(whiteDoc.id)

    // Confirms the premise: both really did collapse to the SAME degenerate hash — this is the
    // exact scenario that would false-positive without the guard.
    expect(blackDoc.phash).toBe('0000000000000000')
    expect(whiteDoc.phash).toBe('0000000000000000')

    expect(blackDoc.duplicateSuspected).toBe(false)
    expect(whiteDoc.duplicateSuspected).toBe(false)

    const whiteKuratorView = await fetchAsKurator(whiteDoc.id)
    expect(whiteKuratorView.duplicateSuspected).toBe(false)
    expect(whiteKuratorView.duplicateOf).toBeFalsy()
  })
})

// m1 (review): hard-deleting a photo must clear duplicateSuspected on any OTHER photo whose
// duplicateOf pointed at it — the FK nulls duplicateOf itself, but the sibling boolean needs an
// explicit hook (captureDuplicateReferencesBeforeDelete / clearDuplicateFlagsAfterDelete in
// Photos.ts) to follow it.
describe('duplicateSuspected clears when the referenced photo is deleted (m1)', () => {
  it('A uploaded, then B flagged against A; deleting A clears B.duplicateSuspected', async () => {
    const baseJpeg = await buildBaseJpeg()
    const resA = await uploadBuffer(baseJpeg, 'dup-delete-a.jpg')
    const jsonA = (await resA.json()) as { doc?: PhotoDoc; errors?: { message: string }[] }
    expect(resA.status, JSON.stringify(jsonA.errors)).toBe(201)
    const aId = (jsonA.doc as PhotoDoc).id
    // Intentionally NOT pushed to createdPhotoIds — this test hard-deletes A itself below; the
    // shared afterAll's bulk `id: { in: [...] }` delete is a no-op for an id that's already gone.

    const rescanned = await sharp(baseJpeg).jpeg({ quality: 60 }).toBuffer()
    const resB = await uploadBuffer(rescanned, 'dup-delete-b.jpg')
    const jsonB = (await resB.json()) as { doc?: PhotoDoc; errors?: { message: string }[] }
    expect(resB.status, JSON.stringify(jsonB.errors)).toBe(201)
    const bId = (jsonB.doc as PhotoDoc).id
    createdPhotoIds.push(bId)

    // Confirm the premise via the Local API (sees duplicateOf regardless of field access, since
    // overrideAccess is a system-level bypass): B really is flagged against A before the delete.
    const bBeforeDelete = await payload.findByID({ collection: 'photos', id: bId, overrideAccess: true, depth: 0 })
    expect(bBeforeDelete.duplicateSuspected).toBe(true)
    expect(bBeforeDelete.duplicateOf).toBe(aId)

    await payload.delete({ collection: 'photos', id: aId, overrideAccess: true })

    const bAfterDelete = await payload.findByID({ collection: 'photos', id: bId, overrideAccess: true, depth: 0 })
    expect(bAfterDelete.duplicateSuspected).toBe(false)
    expect(bAfterDelete.duplicateOf).toBeFalsy()
  })
})
