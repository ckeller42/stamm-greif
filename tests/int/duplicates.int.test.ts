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

beforeAll(async () => {
  payload = await getPayload({ config: await config })
  memberEmail = `dup-mitglied-${Date.now()}@example.com`
  kuratorEmail = `dup-kurator-${Date.now()}@example.com`
  await payload.create({
    collection: 'users',
    data: { name: 'Duplikat Test Mitglied', email: memberEmail, password, role: 'mitglied' },
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

async function fetchAsKurator(id: number): Promise<PhotoDoc> {
  const cookie = await loginCookie(kuratorEmail)
  const res = await fetch(`http://localhost:3000/api/photos/${id}`, { headers: { cookie } })
  expect(res.status).toBe(200)
  return (await res.json()) as PhotoDoc
}

interface PhotoDoc {
  id: number
  phash?: string
  duplicateOf?: number | { id: number } | null
  duplicateSuspected?: boolean
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

    // duplicateSuspected is readable by any authenticated user (including the uploading
    // mitglied's own create response) — see Photos.ts's field comment.
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
