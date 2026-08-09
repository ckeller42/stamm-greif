// Integration: P2.3 face detection. Runs the REAL models (scripts/fetch-face-models.sh runs as
// part of `pnpm test:int`) — there is no stub. The HTTP blocks need the dev server running
// against the TEST database, same setup as invites.int.test.ts.
//
// The "real fixtures" describe block below is carried over from Task 1's review: the reviewer's
// manual same-person/different-person embedding comparison (0.61 vs -0.03..-0.06 cosine
// similarity, see task-1-report.md) is pinned here as an automated assertion so a silent
// alignment regression — a broken warp still produces a plausible-looking vector that never
// matches, per src/lib/face-model.ts's alignedCrop comment — fails CI instead of only showing up
// as "suggestions never appear" in production. Gated on modelsPresent() the same way
// heic.int.test.ts gates on a real functional probe rather than a static self-report: this file
// needs no database for that block, but it lives in tests/int (not tests/unit) because the model
// files are the constraint, not the DB — `pnpm test:int` is the one script that fetches them
// first (package.json's test:int runs scripts/fetch-face-models.sh before vitest).
import { describe, it, expect, beforeAll } from 'vitest'
import { getPayload, type Payload } from 'payload'
import config from '@payload-config'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { cosineSimilarity, similarityThreshold } from '@/lib/faces'
import { analyseFaces, modelsPresent } from '@/lib/face-model'

let payload: Payload
const password = 'geheim123'
let memberEmail: string
let kuratorEmail: string

beforeAll(async () => {
  payload = await getPayload({ config: await config })
  const stamp = Date.now()
  memberEmail = `face-m${stamp}@example.com`
  kuratorEmail = `face-k${stamp}@example.com`
  await payload.create({
    collection: 'users',
    data: { name: 'Face Mitglied', email: memberEmail, password, role: 'mitglied' },
    overrideAccess: true,
  })
  await payload.create({
    collection: 'users',
    data: { name: 'Face Kurator', email: kuratorEmail, password, role: 'kurator' },
    overrideAccess: true,
  })
})

export async function loginCookie(email: string): Promise<string> {
  const res = await fetch('http://localhost:3000/api/users/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  expect(res.ok).toBe(true)
  return res.headers.get('set-cookie') ?? ''
}

describe('face-suggestions access', () => {
  it('a mitglied cannot list face suggestions', async () => {
    const cookie = await loginCookie(memberEmail)
    const res = await fetch('http://localhost:3000/api/face-suggestions', { headers: { cookie } })
    expect(res.status).toBe(403)
  })

  it('a kurator can list them', async () => {
    const cookie = await loginCookie(kuratorEmail)
    const res = await fetch('http://localhost:3000/api/face-suggestions', { headers: { cookie } })
    expect(res.status).toBe(200)
  })

  it('the embedding never appears in an API response, even for a kurator', async () => {
    const photo = await payload.create({
      collection: 'photos',
      data: { caption: 'Zugriffstest', datePrecision: 'unknown', _status: 'published' },
      filePath: 'tests/fixtures/gesicht-a.jpg',
      overrideAccess: true,
    })
    await payload.create({
      collection: 'face-suggestions',
      data: {
        photo: photo.id,
        boxXMin: 0.1, boxYMin: 0.1, boxXMax: 0.4, boxYMax: 0.4,
        embedding: [0.1, 0.2, 0.3],
        status: 'offen',
      },
      overrideAccess: true,
    })
    const cookie = await loginCookie(kuratorEmail)
    const res = await fetch(`http://localhost:3000/api/face-suggestions?where[photo][equals]=${photo.id}`, {
      headers: { cookie },
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { docs: Record<string, unknown>[] }
    expect(json.docs.length).toBe(1)
    expect(json.docs[0].embedding).toBeUndefined()
  })
})

// Carried from Task 1 review: pin the empirically-measured same-person/different-person
// separation against the real fixtures, so a silent alignment or model-swap regression fails CI
// rather than only surfacing as "suggestions never appear" once this ships. gesicht-a.jpg and
// gesicht-b.jpg are two different photographs of the same person (Akihiko Hoshide, 16 years
// apart); gesicht-c.jpg is a different person (Kent Rominger) — see tests/fixtures/README.md for
// full provenance.
describe.skipIf(!modelsPresent())('analyseFaces on real fixtures', () => {
  it('same-person similarity clears the threshold and beats different-person similarity', async () => {
    const [a, b, c] = await Promise.all(
      ['gesicht-a.jpg', 'gesicht-b.jpg', 'gesicht-c.jpg'].map(async (name) => {
        const buf = await readFile(path.resolve(process.cwd(), 'tests/fixtures', name))
        const result = await analyseFaces(buf)
        expect(result.faces.length).toBeGreaterThan(0)
        return result.faces[0].embedding
      }),
    )
    const samePerson = cosineSimilarity(a, b)
    const differentPerson = cosineSimilarity(a, c)
    const threshold = similarityThreshold()
    expect(samePerson).toBeGreaterThan(threshold)
    expect(differentPerson).toBeLessThan(threshold)
    expect(samePerson).toBeGreaterThan(differentPerson)
  })
})
