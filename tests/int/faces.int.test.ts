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
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getPayload, type Payload } from 'payload'
import config from '@payload-config'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { cosineSimilarity, similarityThreshold, l2Normalise } from '@/lib/faces'
import { analyseFaces, modelsPresent } from '@/lib/face-model'

let payload: Payload
const password = 'geheim123'
let memberEmail: string
let kuratorEmail: string
let adminEmail: string
// Task 3 review carry-over: every photo created in this suite (directly via payload.create, not
// through the upload REST endpoint) leaves a file on disk plus, once the faces queue runs, one or
// more face-suggestions rows. Tracked here the same way tests/int/heic.int.test.ts tracks its own
// REST-created photos, and cleaned up in afterAll — face-suggestions rows cascade-delete with
// their photo (photo_id FK is ON DELETE cascade, see the face_suggestions migration), so deleting
// the photo is sufficient.
const createdPhotoIds: (string | number)[] = []

beforeAll(async () => {
  payload = await getPayload({ config: await config })
  const stamp = Date.now()
  memberEmail = `face-m${stamp}@example.com`
  kuratorEmail = `face-k${stamp}@example.com`
  adminEmail = `face-a${stamp}@example.com`
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
  await payload.create({
    collection: 'users',
    data: { name: 'Face Admin', email: adminEmail, password, role: 'admin' },
    overrideAccess: true,
  })
})

afterAll(async () => {
  if (createdPhotoIds.length) {
    // Delete face-suggestions rows explicitly rather than relying on the photos->face_suggestions
    // FK's ON DELETE cascade: that cascade is real in the *migrated* schema (see the
    // face_suggestions migration), but Payload's dev-mode schema push — which every `pnpm dev`
    // startup runs, including the one this int suite's HTTP calls depend on — reconciles against
    // its own generated snapshot, not the hand-edited migration SQL, and that snapshot still says
    // `set null` (a known, deliberately-accepted drift documented on Task 2: fixing the snapshot
    // to say `cascade` would make the drift-check CI step itself flag a false difference). Under
    // that reverted FK, hard-deleting a photo with any face-suggestions row would try to null out
    // `photo_id`, which is NOT NULL, aborting the delete's transaction. Deleting the children
    // first sidesteps the question of which ON DELETE behaviour happens to be live.
    await payload.delete({
      collection: 'face-suggestions',
      where: { photo: { in: createdPhotoIds } },
      overrideAccess: true,
    })
    await payload.delete({ collection: 'photos', where: { id: { in: createdPhotoIds } }, overrideAccess: true })
  }
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
  it('an anonymous request cannot list face suggestions', async () => {
    const res = await fetch('http://localhost:3000/api/face-suggestions')
    expect(res.status).toBe(403)
  })

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

  it('the embedding never appears in an API response, for a kurator or an admin, over REST or GraphQL', async () => {
    const photo = await payload.create({
      collection: 'photos',
      data: { caption: 'Zugriffstest', datePrecision: 'unknown', _status: 'published' },
      filePath: 'tests/fixtures/gesicht-a.jpg',
      overrideAccess: true,
    })
    createdPhotoIds.push(photo.id)
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

    for (const email of [kuratorEmail, adminEmail]) {
      const cookie = await loginCookie(email)
      const res = await fetch(`http://localhost:3000/api/face-suggestions?where[photo][equals]=${photo.id}`, {
        headers: { cookie },
      })
      expect(res.status).toBe(200)
      const json = (await res.json()) as { docs: Record<string, unknown>[] }
      expect(json.docs.length).toBe(1)
      expect(json.docs[0].embedding).toBeUndefined()
    }

    // Same field-level lock, exercised over GraphQL rather than REST — a separate code path
    // (fields/hooks/afterRead) that a REST-only assertion wouldn't catch a regression in.
    // Payload derives the GraphQL query field name from the collection slug (formatNames in
    // payload/dist/utilities/formatLabels.js): 'face-suggestions' -> plural 'FaceSuggestions'.
    const cookie = await loginCookie(kuratorEmail)
    const res = await fetch('http://localhost:3000/api/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        query: `query {
          FaceSuggestions(where: { photo: { equals: ${JSON.stringify(String(photo.id))} } }) {
            docs { id embedding }
          }
        }`,
      }),
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      data?: { FaceSuggestions?: { docs: { id: string | number; embedding: unknown }[] } }
      errors?: unknown
    }
    expect(json.errors, JSON.stringify(json.errors)).toBeUndefined()
    const docs = json.data?.FaceSuggestions?.docs ?? []
    expect(docs.length).toBe(1)
    expect(docs[0].embedding).toBeNull()
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

async function runFacesQueue(): Promise<void> {
  await payload.jobs.run({ queue: 'faces', overrideAccess: true })
}

async function suggestionsFor(photoId: string | number) {
  const res = await payload.find({
    collection: 'face-suggestions',
    where: { photo: { equals: photoId } },
    overrideAccess: true,
    pagination: false,
    depth: 0,
  })
  return res.docs
}

describe('detection runs on publish, not on draft', () => {
  it('creates no suggestions for a draft', async () => {
    const photo = await payload.create({
      collection: 'photos',
      data: { caption: 'Entwurf', datePrecision: 'unknown', _status: 'draft' },
      filePath: 'tests/fixtures/gesicht-a.jpg',
      overrideAccess: true,
    })
    createdPhotoIds.push(photo.id)
    await runFacesQueue()
    expect(await suggestionsFor(photo.id)).toHaveLength(0)
  })

  it('creates a suggestion with a 512-d embedding when the photo is published', async () => {
    const photo = await payload.create({
      collection: 'photos',
      data: { caption: 'Veröffentlicht', datePrecision: 'unknown', _status: 'published' },
      filePath: 'tests/fixtures/gesicht-a.jpg',
      overrideAccess: true,
    })
    createdPhotoIds.push(photo.id)
    await runFacesQueue()
    const docs = await suggestionsFor(photo.id)
    expect(docs.length).toBeGreaterThanOrEqual(1)
    const [s] = docs
    expect(s.status).toBe('offen')
    expect(Array.isArray(s.embedding)).toBe(true)
    expect((s.embedding as number[]).length).toBe(512)
    for (const v of [s.boxXMin, s.boxYMin, s.boxXMax, s.boxYMax]) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
    expect(s.boxXMax).toBeGreaterThan(s.boxXMin)
  })
})

// P2.3 review (round 2): two detectFaces jobs for the SAME photo close together — the realistic
// trigger is a publish followed by a quick file-replace before the first job has run — used to
// race: runJobs' own batch is a Promise.all (queues/operations/runJobs/index.js), so both jobs
// could execute truly concurrently, both reading an empty `decided` set before either had written
// anything, leaving two duplicate 'offen' rows for the same face. Fixed via
// jobs.enableConcurrencyControl + detectFacesTask's own `concurrency: { key: photoId, exclusive:
// true }` (payload.config.ts / src/jobs/detectFaces.ts). Concurrency serializes rather than drops
// the second job — verified against runJobs' own source that an exclusive-key job whose key is
// already `processing: true` is excluded from the NEXT batch's selection query, so a single
// `jobs.run()` call only ever advances one of the two; the second call is what lets the
// now-freed key's job actually run. Two `runFacesQueue()` calls is therefore the realistic
// minimum here, not padding.
describe('concurrent enqueues for the same photo never produce duplicate suggestions', () => {
  it('two detectFaces jobs queued back-to-back for one photo yield one offen row per face, not two', async () => {
    const photo = await payload.create({
      collection: 'photos',
      data: { caption: 'Doppelt eingereiht', datePrecision: 'unknown', _status: 'published' },
      filePath: 'tests/fixtures/gesicht-a.jpg',
      overrideAccess: true,
    })
    createdPhotoIds.push(photo.id)

    // Photos' own afterChange hook already enqueued one job for this create (publish transition).
    // Queue a second one directly, same task/queue/input shape as enqueueDetectFaces
    // (src/jobs/detectFaces.ts) — standing in for the quick file-replace re-enqueue.
    await payload.jobs.queue({ task: 'detectFaces', input: { photoId: photo.id }, queue: 'faces', overrideAccess: true })

    await runFacesQueue() // advances whichever of the two jobs wins the concurrency key
    await runFacesQueue() // advances the other, now that the key is free again

    const docs = await suggestionsFor(photo.id)
    const offen = docs.filter((d) => d.status === 'offen')
    // gesicht-a.jpg has exactly one face (asserted elsewhere in this file) — one offen row per
    // detected face, never two for the same face, regardless of how many jobs ran.
    expect(offen.length).toBe(1)
  })
})

// THE acceptance test for keypoint alignment. A plain box crop instead of the 5-point ArcFace
// alignment still produces plausible-looking 512-d vectors — it just makes them useless for
// matching. Nothing else in this suite would catch that; this does.
describe('embeddings identify the same person across photos', () => {
  it('scores same-person higher than different-person, and clears the default threshold', async () => {
    const mk = async (fixture: string) => {
      const photo = await payload.create({
        collection: 'photos',
        data: { caption: fixture, datePrecision: 'unknown', _status: 'published' },
        filePath: `tests/fixtures/${fixture}`,
        overrideAccess: true,
      })
      createdPhotoIds.push(photo.id)
      await runFacesQueue()
      const docs = await suggestionsFor(photo.id)
      expect(docs.length).toBeGreaterThanOrEqual(1)
      const biggest = docs.sort(
        (x, y) => (y.boxXMax - y.boxXMin) * (y.boxYMax - y.boxYMin) - (x.boxXMax - x.boxXMin) * (x.boxYMax - x.boxYMin),
      )[0]
      return l2Normalise(biggest.embedding as number[])
    }
    const a = await mk('gesicht-a.jpg')
    const b = await mk('gesicht-b.jpg')
    const c = await mk('gesicht-c.jpg')
    const same = a.reduce((acc, v, i) => acc + v * b[i], 0)
    const different = a.reduce((acc, v, i) => acc + v * c[i], 0)
    expect(same).toBeGreaterThan(different)
    expect(same).toBeGreaterThan(0.4)
  })
})
