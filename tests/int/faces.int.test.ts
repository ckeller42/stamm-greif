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
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { getPayload, type Payload } from 'payload'
import config from '@payload-config'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
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
// Final review, L1/L2: EVERY person created anywhere in this suite is tracked here and cleaned up
// in afterAll, including ones the test itself hides or otherwise mutates — hiding/purging a
// person's face data (People's own afterChange hook) never deletes the PERSON row itself, so
// without this every person-creating test leaks a row per CI run. (The previous version of this
// comment only mentioned two specific tests by name; that stopped being true the moment a third
// test started creating a person, and by the time of this review most of them already did.)
const createdPersonIds: (string | number)[] = []

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
  if (createdPersonIds.length) {
    await payload.delete({ collection: 'people', where: { id: { in: createdPersonIds } }, overrideAccess: true })
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
  // A single payload.jobs.run() call only processes up to its `limit` (default 10) per
  // invocation — fine for most tests here, but Task 6's backfillFaces tests can leave dozens of
  // jobs queued at once (backfillFacesHandler enqueues for every eligible published photo in the
  // whole test database, not just this file's own), and a freshly-enqueued job can land well
  // behind that backlog in FIFO order. Loop until Payload itself reports nothing left rather than
  // assume one call reaches the job a given test actually cares about.
  let result = await payload.jobs.run({ queue: 'faces', overrideAccess: true })
  let iterations = 0
  while (!result.noJobsRemaining && iterations < 50) {
    result = await payload.jobs.run({ queue: 'faces', overrideAccess: true })
    iterations++
  }
  // Review (Task 6, round 2), Low: hitting the cap without ever seeing `noJobsRemaining` means
  // the queue genuinely never drained (a real stuck/looping job, not just "this test's own
  // backlog is unusually deep") — silently returning here would have every caller's SUBSEQUENT
  // assertion fail with a confusing "no suggestion found" instead of pointing at the actual queue
  // problem.
  if (!result.noJobsRemaining) {
    throw new Error(`runFacesQueue: 'faces' queue did not drain after ${iterations} iterations`)
  }
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

// Final review, H2: every call site below used to do `const [row] = await suggestionsFor(...)`
// straight after `runFacesQueue()` — a bare destructure that's `undefined` on the very first row
// whenever nothing showed up yet, which then fails several lines later with a confusing "Cannot
// read properties of undefined" instead of pointing at the actual problem. `runFacesQueue()`
// itself already drains the `faces` queue fully (loops to `noJobsRemaining`), so by the time this
// runs the row should already exist — this is a short bounded RETRY on top of that (not the
// primary defense: `shouldAutoRun` in payload.config.ts is what actually stops a concurrent
// `pnpm dev` autoRun tick from racing this suite's own explicit runs) with an assertion that
// fails LOUDLY, at the actual point of the problem, if it still doesn't.
async function firstSuggestionFor(
  photoId: string | number,
  attempts = 5,
  delayMs = 200,
): Promise<Awaited<ReturnType<typeof suggestionsFor>>[number]> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const docs = await suggestionsFor(photoId)
    if (docs.length > 0) return docs[0]
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  throw new Error(
    `firstSuggestionFor: no face-suggestions row appeared for photo ${photoId} after ` +
      `${attempts} attempts (${(attempts - 1) * delayMs}ms) — runFacesQueue() should already ` +
      'have drained the faces queue by this point.',
  )
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
    // gesicht-a.jpg has exactly one face — pinned here so the "asserted elsewhere in this file"
    // comment on the concurrent-enqueues test below stays true.
    expect(docs.length).toBe(1)
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

describe('confirm / reject / undo', () => {
  it('a mitglied is refused on all three endpoints', async () => {
    const cookie = await loginCookie(memberEmail)
    for (const action of ['bestaetigen', 'ablehnen', 'zuruecksetzen']) {
      const res = await fetch(`http://localhost:3000/api/face-suggestions/1/${action}`, {
        method: 'POST',
        headers: { cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ personId: 1 }),
      })
      expect(res.status).toBe(403)
    }
  })

  it('confirming tags the person, indexes the row end to end, and undo removes the tag again', async () => {
    const person = await payload.create({
      collection: 'people', data: { name: `Bestätigt ${Date.now()}` }, overrideAccess: true,
    })
    createdPersonIds.push(person.id)
    const photo = await payload.create({
      collection: 'photos',
      data: { caption: 'bestätigen', datePrecision: 'unknown', _status: 'published' },
      filePath: 'tests/fixtures/gesicht-a.jpg',
      overrideAccess: true,
    })
    createdPhotoIds.push(photo.id)
    await runFacesQueue()
    const row = await firstSuggestionFor(photo.id)
    const cookie = await loginCookie(kuratorEmail)

    const ok = await fetch(`http://localhost:3000/api/face-suggestions/${row.id}/bestaetigen`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ personId: person.id }),
    })
    expect(ok.status).toBe(200)
    let after = await payload.findByID({ collection: 'photos', id: photo.id, overrideAccess: true, depth: 0 })
    expect((after.people ?? []).map(String)).toContain(String(person.id))

    // Final review, M6: the endpoint's own effect on the row itself — not just the photo tag —
    // was never asserted anywhere in this file.
    const confirmedRow = await payload.findByID({
      collection: 'face-suggestions', id: row.id, overrideAccess: true, depth: 0,
    })
    expect(confirmedRow.status).toBe('bestaetigt')
    expect(String(confirmedRow.suggestedPerson)).toBe(String(person.id))
    expect(confirmedRow.confirmedBy).toBeTruthy()
    expect(confirmedRow.confirmedAt).toBeTruthy()
    expect(Array.isArray(confirmedRow.embedding)).toBe(true)
    expect((confirmedRow.embedding as number[]).length).toBe(512)

    // Final review, M6: the endpoint→index path end to end — this confirmed row is what
    // `bestMatchPerPerson` draws its index from (src/jobs/detectFaces.ts), so a SECOND photo of
    // the same person (gesicht-b.jpg — same person as gesicht-a.jpg, see this file's own
    // "embeddings identify the same person" test) should now come back suggesting them
    // automatically, without ever going through /gesichter for this second photo.
    const second = await payload.create({
      collection: 'photos',
      data: { caption: 'bestätigen-zweites', datePrecision: 'unknown', _status: 'published' },
      filePath: 'tests/fixtures/gesicht-b.jpg',
      overrideAccess: true,
    })
    createdPhotoIds.push(second.id)
    await runFacesQueue()
    const secondRows = await suggestionsFor(second.id)
    const matched = secondRows.find((r) => String(r.suggestedPerson) === String(person.id))
    expect(matched).toBeDefined()

    const undo = await fetch(`http://localhost:3000/api/face-suggestions/${row.id}/zuruecksetzen`, {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: '{}',
    })
    expect(undo.status).toBe(200)
    after = await payload.findByID({ collection: 'photos', id: photo.id, overrideAccess: true, depth: 0 })
    expect((after.people ?? []).map(String)).not.toContain(String(person.id))
  })

  it('rejecting deletes the embedding', async () => {
    const photo = await payload.create({
      collection: 'photos',
      data: { caption: 'ablehnen', datePrecision: 'unknown', _status: 'published' },
      filePath: 'tests/fixtures/gesicht-c.jpg',
      overrideAccess: true,
    })
    createdPhotoIds.push(photo.id)
    await runFacesQueue()
    const row = await firstSuggestionFor(photo.id)
    const cookie = await loginCookie(kuratorEmail)
    const res = await fetch(`http://localhost:3000/api/face-suggestions/${row.id}/ablehnen`, {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: '{}',
    })
    expect(res.status).toBe(200)
    const reloaded = await payload.findByID({
      collection: 'face-suggestions', id: row.id, overrideAccess: true, depth: 0,
    })
    expect(reloaded.status).toBe('abgelehnt')
    expect(reloaded.embedding).toBeFalsy()
  })

  it('confirming a hidden person is refused with 409', async () => {
    const person = await payload.create({
      collection: 'people', data: { name: `Verborgen ${Date.now()}`, hidden: true }, overrideAccess: true,
    })
    createdPersonIds.push(person.id)
    const photo = await payload.create({
      collection: 'photos',
      data: { caption: 'verborgen', datePrecision: 'unknown', _status: 'published' },
      filePath: 'tests/fixtures/gesicht-b.jpg',
      overrideAccess: true,
    })
    createdPhotoIds.push(photo.id)
    await runFacesQueue()
    const row = await firstSuggestionFor(photo.id)
    const cookie = await loginCookie(kuratorEmail)
    const res = await fetch(`http://localhost:3000/api/face-suggestions/${row.id}/bestaetigen`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ personId: person.id }),
    })
    expect(res.status).toBe(409)
  })
})

describe('matching against confirmed faces', () => {
  it('suggests the person on a second photo once the first is confirmed', async () => {
    const person = await payload.create({
      collection: 'people',
      data: { name: `Testperson ${Date.now()}` },
      overrideAccess: true,
    })
    createdPersonIds.push(person.id)
    const first = await payload.create({
      collection: 'photos',
      data: { caption: 'erstes', datePrecision: 'unknown', _status: 'published' },
      filePath: 'tests/fixtures/gesicht-a.jpg',
      overrideAccess: true,
    })
    createdPhotoIds.push(first.id)
    await runFacesQueue()
    const firstRow = await firstSuggestionFor(first.id)
    // No index yet, so nothing can be suggested on the very first photo of a person.
    expect(firstRow.suggestedPerson).toBeFalsy()

    await payload.update({
      collection: 'face-suggestions',
      id: firstRow.id,
      data: { status: 'bestaetigt', suggestedPerson: person.id },
      overrideAccess: true,
    })

    const second = await payload.create({
      collection: 'photos',
      data: { caption: 'zweites', datePrecision: 'unknown', _status: 'published' },
      filePath: 'tests/fixtures/gesicht-b.jpg',
      overrideAccess: true,
    })
    createdPhotoIds.push(second.id)
    await runFacesQueue()
    const rows = await suggestionsFor(second.id)
    const matched = rows.find((r) => String(r.suggestedPerson) === String(person.id))
    expect(matched).toBeDefined()
    expect(matched!.similarity).toBeGreaterThan(0.4)
  })

  // GDPR-critical regression test carried over from Task 4's review: match-time exclusion. A
  // person's consent can be withdrawn (`hidden: true`) in the window between their face being
  // confirmed on one photo and a second, later photo of the same face being processed — this
  // pins that the second photo's detectFaces run never re-surfaces the withdrawn person as a
  // suggestion, whether that's because purgeFaceDataForHiddenPerson already removed the
  // confirmed row the match would have been built from, or because of detectFacesHandler's own
  // belt-and-braces hiddenIds filter (src/jobs/detectFaces.ts) — either mechanism satisfies the
  // one thing that actually matters here: consent withdrawal must never come apart from match
  // exclusion.
  it('a hidden person is never re-suggested on a later photo of the same face', async () => {
    const person = await payload.create({
      collection: 'people',
      data: { name: `Widerrufen ${Date.now()}` },
      overrideAccess: true,
    })
    createdPersonIds.push(person.id)
    const first = await payload.create({
      collection: 'photos',
      data: { caption: 'widerrufen-erstes', datePrecision: 'unknown', _status: 'published' },
      filePath: 'tests/fixtures/gesicht-a.jpg',
      overrideAccess: true,
    })
    createdPhotoIds.push(first.id)
    await runFacesQueue()
    const firstRow = await firstSuggestionFor(first.id)
    await payload.update({
      collection: 'face-suggestions',
      id: firstRow.id,
      data: { status: 'bestaetigt', suggestedPerson: person.id },
      overrideAccess: true,
    })

    // Consent withdrawn between the first confirmation and the second photo being processed.
    await payload.update({
      collection: 'people', id: person.id, data: { hidden: true }, overrideAccess: true,
    })

    const second = await payload.create({
      collection: 'photos',
      data: { caption: 'widerrufen-zweites', datePrecision: 'unknown', _status: 'published' },
      filePath: 'tests/fixtures/gesicht-b.jpg',
      overrideAccess: true,
    })
    createdPhotoIds.push(second.id)
    await runFacesQueue()
    const rows = await suggestionsFor(second.id)
    expect(rows.every((r) => String(r.suggestedPerson) !== String(person.id))).toBe(true)
  })
})

describe('consent purge and delete cascade', () => {
  it('hiding a person deletes every face-suggestions row naming them', async () => {
    const person = await payload.create({
      collection: 'people', data: { name: `Purge ${Date.now()}` }, overrideAccess: true,
    })
    createdPersonIds.push(person.id)
    const photo = await payload.create({
      collection: 'photos',
      data: { caption: 'purge', datePrecision: 'unknown', _status: 'published' },
      filePath: 'tests/fixtures/gesicht-a.jpg',
      overrideAccess: true,
    })
    createdPhotoIds.push(photo.id)
    await runFacesQueue()
    const row = await firstSuggestionFor(photo.id)
    await payload.update({
      collection: 'face-suggestions', id: row.id,
      data: { status: 'bestaetigt', suggestedPerson: person.id }, overrideAccess: true,
    })
    // present before, so the assertion after cannot pass vacuously
    expect(
      (await payload.find({
        collection: 'face-suggestions',
        where: { suggestedPerson: { equals: person.id } },
        overrideAccess: true, pagination: false,
      })).docs.length,
    ).toBe(1)

    await payload.update({
      collection: 'people', id: person.id, data: { hidden: true }, overrideAccess: true,
    })
    expect(
      (await payload.find({
        collection: 'face-suggestions',
        where: { suggestedPerson: { equals: person.id } },
        overrideAccess: true, pagination: false,
      })).docs.length,
    ).toBe(0)
  })

  // Final review, M3: consent purge's original `suggestedPerson`-only query misses a
  // misattributed row entirely — this person's actual face confirmed to a DIFFERENT person by
  // mistake, while they're tagged on the same photo through a separate path (here, directly in
  // `photos.people`, standing in for however that tag was actually made — a manual admin edit, or
  // confirming a different face on the same photo to them). purgeFaceDataForPerson now also
  // purges every face-suggestions row on any photo the hidden person is tagged on, regardless of
  // what `suggestedPerson` those rows say — this is the row-by-id check that actually proves that
  // path, not just the `suggestedPerson`-scoped query the first test in this block already covers.
  it('hiding a person also purges a row on their photo that was misattributed to someone else', async () => {
    const personA = await payload.create({
      collection: 'people', data: { name: `MisattribA ${Date.now()}` }, overrideAccess: true,
    })
    createdPersonIds.push(personA.id)
    const personB = await payload.create({
      collection: 'people', data: { name: `MisattribB ${Date.now()}` }, overrideAccess: true,
    })
    createdPersonIds.push(personB.id)
    const photo = await payload.create({
      collection: 'photos',
      data: { caption: 'misattributed', datePrecision: 'unknown', _status: 'published' },
      filePath: 'tests/fixtures/gesicht-a.jpg',
      overrideAccess: true,
    })
    createdPhotoIds.push(photo.id)
    await runFacesQueue()
    const row = await firstSuggestionFor(photo.id)
    // A's actual detected face, confirmed to B by mistake — the embedding is A's, the row names B.
    await payload.update({
      collection: 'face-suggestions', id: row.id,
      data: { status: 'bestaetigt', suggestedPerson: personB.id }, overrideAccess: true,
    })
    // A is tagged on this same photo some other way (e.g. a direct admin edit of `people`, or a
    // second face on the photo confirmed to them separately) — never through this specific row.
    await payload.update({
      collection: 'photos', id: photo.id, data: { people: [personA.id] }, overrideAccess: true,
    })

    // Present before, so the purge assertion below cannot pass vacuously.
    const before = await payload.findByID({
      collection: 'face-suggestions', id: row.id, overrideAccess: true, depth: 0,
    })
    expect(before).toBeTruthy()
    expect(String(before.suggestedPerson)).toBe(String(personB.id))

    await payload.update({
      collection: 'people', id: personA.id, data: { hidden: true }, overrideAccess: true,
    })

    // Raw by-id check — the row must be genuinely gone, not merely absent from a
    // suggestedPerson-scoped query (which would pass vacuously here, since the row never named A).
    const after = await payload.findByID({
      collection: 'face-suggestions', id: row.id, overrideAccess: true, depth: 0, disableErrors: true,
    })
    expect(after).toBeNull()
  })

  it('hard-deleting a photo removes its suggestions via the FK cascade', async () => {
    const photo = await payload.create({
      collection: 'photos',
      data: { caption: 'cascade', datePrecision: 'unknown', _status: 'published' },
      filePath: 'tests/fixtures/gesicht-b.jpg',
      overrideAccess: true,
    })
    await runFacesQueue()
    expect((await suggestionsFor(photo.id)).length).toBeGreaterThanOrEqual(1)
    await payload.delete({ collection: 'photos', id: photo.id, overrideAccess: true })
    expect(await suggestionsFor(photo.id)).toHaveLength(0)
  })

  it('reconcileHiddenFaceData cleans up rows a restore would have resurrected', async () => {
    const person = await payload.create({
      collection: 'people', data: { name: `Restore ${Date.now()}`, hidden: true }, overrideAccess: true,
    })
    createdPersonIds.push(person.id)
    const photo = await payload.create({
      collection: 'photos',
      data: { caption: 'restore', datePrecision: 'unknown', _status: 'published' },
      filePath: 'tests/fixtures/gesicht-c.jpg',
      overrideAccess: true,
    })
    createdPhotoIds.push(photo.id)
    await runFacesQueue()
    const row = await firstSuggestionFor(photo.id)
    // simulate a restored backup: a row naming an already-hidden person
    await payload.update({
      collection: 'face-suggestions', id: row.id,
      data: { status: 'bestaetigt', suggestedPerson: person.id }, overrideAccess: true,
    })
    await payload.jobs.queue({ task: 'reconcileHiddenFaceData', input: {} })
    await payload.jobs.run({ overrideAccess: true })
    expect(
      (await payload.find({
        collection: 'face-suggestions',
        where: { suggestedPerson: { equals: person.id } },
        overrideAccess: true, pagination: false,
      })).docs.length,
    ).toBe(0)
  })

  // Review (Task 6, round 2), C1: face_suggestions.suggested_person_id is `ON DELETE set null`,
  // in every deploy mode — never hand-edited to cascade the way photos.id was. A HARD DELETE of
  // the person fires that FK action INSIDE the `DELETE FROM people` statement, before any
  // afterDelete hook runs, nulling `suggested_person_id` on the row first. A `where: {
  // suggestedPerson: { equals: personId } }` query run afterward — this suite's existing purge
  // tests, and the original (pre-fix) afterDelete hook — therefore matches nothing: the row (and,
  // for a `bestaetigt` one, its embedding) survives forever, with the biometric template intact,
  // unreachable by reconcileHiddenFaceData (same query shape) and untouched by the 180-day sweep
  // (only ever looks at `offen` rows). This asserts the row itself is gone by id — not just that
  // `suggestedPerson` got nulled — which is the one assertion shape that actually distinguishes
  // "purged" from "silently orphaned."
  it('hard-deleting a person purges their face-suggestions rows, not just nulls suggestedPerson (C1)', async () => {
    const person = await payload.create({
      collection: 'people', data: { name: `HardDelete ${Date.now()}` }, overrideAccess: true,
    })
    createdPersonIds.push(person.id)
    const photo = await payload.create({
      collection: 'photos',
      data: { caption: 'hard-delete-purge', datePrecision: 'unknown', _status: 'published' },
      filePath: 'tests/fixtures/gesicht-a.jpg',
      overrideAccess: true,
    })
    createdPhotoIds.push(photo.id)
    await runFacesQueue()
    const row = await firstSuggestionFor(photo.id)
    await payload.update({
      collection: 'face-suggestions', id: row.id,
      data: { status: 'bestaetigt', suggestedPerson: person.id }, overrideAccess: true,
    })
    // The embedding is present before the delete, so "the row is gone" below can't pass vacuously
    // because there was never anything to purge in the first place.
    const before = await payload.findByID({
      collection: 'face-suggestions', id: row.id, overrideAccess: true, depth: 0,
    })
    expect(before.embedding).toBeTruthy()

    await payload.delete({ collection: 'people', id: person.id, overrideAccess: true })

    const after = await payload.findByID({
      collection: 'face-suggestions', id: row.id, overrideAccess: true, depth: 0, disableErrors: true,
    })
    expect(after).toBeNull()
  })
})

// Review (Task 6, round 2), M(a): the "cannot come apart" guarantee purge-face-data.ts's own
// comment claims — hiding a person and purging their face data happen in ONE transaction — was
// never actually exercised by a failure. FACES_TEST_FORCE_PURGE_FAILURE is an env-gated
// injection point purgeFaceDataForPerson checks before doing any real work (src/hooks/
// purge-face-data.ts), so this can force the purge to fail without needing a real DB-level fault.
describe('a forced purge failure rolls back the hidden flag, not just skips the purge', () => {
  it('single-doc update({ hidden: true }) throws and hidden reloads false', async () => {
    const person = await payload.create({
      collection: 'people', data: { name: `ForceFail ${Date.now()}` }, overrideAccess: true,
    })
    createdPersonIds.push(person.id)
    process.env.FACES_TEST_FORCE_PURGE_FAILURE = '1'
    try {
      await expect(
        payload.update({
          collection: 'people', id: person.id, data: { hidden: true }, overrideAccess: true,
        }),
      ).rejects.toThrow()
    } finally {
      delete process.env.FACES_TEST_FORCE_PURGE_FAILURE
    }
    const reloaded = await payload.findByID({
      collection: 'people', id: person.id, overrideAccess: true, depth: 0,
    })
    expect(reloaded.hidden).toBe(false)
  })
})

// Review (Task 6, round 2), C2: `payload.update({ where })` — the admin list view's bulk-edit
// action, and the identical `PATCH /api/people?where=...` REST call — is a different Payload
// operation (`updateOperation`, collections/operations/update.js) from the single-document
// `updateByID` the normal per-person edit view uses, and `bulkOperationsSingleTransaction`
// defaults to false there: each matched document gets its own transaction, and a hook throwing
// for one document does NOT roll that document's own already-committed write back — it lands in
// the operation's `errors[]` array while the HTTP response still reports success and `hidden`
// stays committed true. `disableBulkEdit: true` (People.ts) closes this specific path entirely by
// rejecting it up front, for any non-overrideAccess caller — verified directly against
// update.js's own guard, which runs before `updateOperation` does anything else.
describe('People bulk edit is disabled (C2)', () => {
  it('a kurator cannot bulk-update people via PATCH .../people?where=... (disableBulkEdit)', async () => {
    const person = await payload.create({
      collection: 'people', data: { name: `BulkEdit ${Date.now()}` }, overrideAccess: true,
    })
    createdPersonIds.push(person.id)
    const cookie = await loginCookie(kuratorEmail)
    const res = await fetch(`http://localhost:3000/api/people?where[id][equals]=${person.id}`, {
      method: 'PATCH',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ hidden: true }),
    })
    expect(res.status).toBe(403)
    const reloaded = await payload.findByID({
      collection: 'people', id: person.id, overrideAccess: true, depth: 0,
    })
    expect(reloaded.hidden).toBe(false)
  })
})

describe('backfillFaces task', () => {
  it(
    'picks up a photo whose publish-time enqueue was skipped (published + binned in one ' +
      'call, later restored)',
    async () => {
      const photo = await payload.create({
        collection: 'photos',
        data: {
          caption: 'binned-at-birth', datePrecision: 'unknown',
          _status: 'published', deletedAt: new Date().toISOString(),
        },
        filePath: 'tests/fixtures/gesicht-a.jpg',
        overrideAccess: true,
      })
      createdPhotoIds.push(photo.id)
      await runFacesQueue()
      // publish-time enqueue was skipped: Photos' afterChange hook bails on `doc.deletedAt`.
      expect(await suggestionsFor(photo.id)).toHaveLength(0)

      // Restore: clearing deletedAt does NOT re-trigger the publish-transition enqueue (the
      // photo was already `_status: 'published'` before this update, and the filename didn't
      // change) — without a backfill run this photo would sit forever with no suggestions.
      await payload.update({
        collection: 'photos', id: photo.id, data: { deletedAt: null }, overrideAccess: true,
      })
      await runFacesQueue()
      expect(await suggestionsFor(photo.id)).toHaveLength(0)

      await payload.jobs.queue({ task: 'backfillFaces', input: {} })
      await payload.jobs.run({ overrideAccess: true })
      await runFacesQueue()

      expect((await suggestionsFor(photo.id)).length).toBeGreaterThanOrEqual(1)
    },
  )

  it(
    'picks up a photo published with a hidden person tagged in one call, later untagged',
    async () => {
      const person = await payload.create({
        collection: 'people',
        data: { name: `Backfill-Hidden ${Date.now()}`, hidden: true },
        overrideAccess: true,
      })
      createdPersonIds.push(person.id)
      const photo = await payload.create({
        collection: 'photos',
        data: {
          caption: 'hidden-at-birth', datePrecision: 'unknown', _status: 'published',
          people: [person.id],
        },
        filePath: 'tests/fixtures/gesicht-b.jpg',
        overrideAccess: true,
      })
      createdPhotoIds.push(photo.id)
      const created = await payload.findByID({
        collection: 'photos', id: photo.id, overrideAccess: true, depth: 0,
      })
      expect(created.hasHiddenPerson).toBe(true)
      await runFacesQueue()
      // publish-time enqueue was skipped: Photos' afterChange hook bails on `doc.hasHiddenPerson`.
      expect(await suggestionsFor(photo.id)).toHaveLength(0)

      // Untag the hidden person: hasHiddenPerson recomputes to false, but this is neither a
      // draft->published transition nor a file change, so the publish-time hook still doesn't
      // re-enqueue.
      await payload.update({
        collection: 'photos', id: photo.id, data: { people: [] }, overrideAccess: true,
      })
      const untagged = await payload.findByID({
        collection: 'photos', id: photo.id, overrideAccess: true, depth: 0,
      })
      expect(untagged.hasHiddenPerson).toBe(false)
      await runFacesQueue()
      expect(await suggestionsFor(photo.id)).toHaveLength(0)

      await payload.jobs.queue({ task: 'backfillFaces', input: {} })
      await payload.jobs.run({ overrideAccess: true })
      await runFacesQueue()

      expect((await suggestionsFor(photo.id)).length).toBeGreaterThanOrEqual(1)
    },
  )

  it(
    're-run semantics: backfilling a photo that already has a decided suggestion leaves it ' +
      'untouched and does not duplicate it',
    async () => {
      const photo = await payload.create({
        collection: 'photos',
        data: { caption: 're-run', datePrecision: 'unknown', _status: 'published' },
        filePath: 'tests/fixtures/gesicht-a.jpg',
        overrideAccess: true,
      })
      createdPhotoIds.push(photo.id)
      await runFacesQueue()
      const row = await firstSuggestionFor(photo.id)
      await payload.update({
        collection: 'face-suggestions', id: row.id,
        data: { status: 'abgelehnt', embedding: null }, overrideAccess: true,
      })

      await payload.jobs.queue({ task: 'backfillFaces', input: {} })
      await payload.jobs.run({ overrideAccess: true })
      await runFacesQueue()

      const docs = await suggestionsFor(photo.id)
      // gesicht-a.jpg has exactly one face (pinned earlier in this file) — the decided
      // (abgelehnt) row survives untouched, and detectFacesHandler's own IoU-suppression against
      // decided boxes stops the re-run from resurrecting a fresh 'offen' row on the same face.
      expect(docs.length).toBe(1)
      expect(docs[0].id).toBe(row.id)
      expect(docs[0].status).toBe('abgelehnt')
    },
  )

  // Review (Task 6, round 2), Low: mirrors purgePapierkorb.int.test.ts's own
  // createDraftSoftDeletedPhoto shape — a photo that IS published on the main row (stale) but
  // whose LATEST version has since been unpublished via a `draft: true` update (`isSavingDraft`
  // skips the main-row write, so the main row never learns about it). Asserted at the job-queue
  // level rather than via a resulting suggestion count: detectFacesHandler's own re-check ALSO
  // reads the (same, stale) main row at run time, so a wrongly re-enqueued job would still
  // eventually produce output indistinguishable from a correctly-skipped one once run — counting
  // how many `detectFaces` jobs exist for this photo id before/after backfillFacesHandler runs is
  // what actually isolates its own candidate-selection query, independent of that.
  it(
    'does not re-enqueue a photo that is stale-published on the main row but ' +
      'draft-unpublished on its latest version',
    async () => {
      const photo = await payload.create({
        collection: 'photos',
        data: { caption: 'stale-main-row', datePrecision: 'unknown', _status: 'published' },
        filePath: 'tests/fixtures/gesicht-c.jpg',
        overrideAccess: true,
      })
      createdPhotoIds.push(photo.id)
      // "Unpublish" via a draft-only update — main row stays _status: 'published' (stale).
      await payload.update({
        collection: 'photos', id: photo.id, draft: true, data: { _status: 'draft' },
        overrideAccess: true,
      })

      const detectFacesJobCountFor = async (photoId: number) => {
        const jobs = await payload.find({
          collection: 'payload-jobs',
          where: { taskSlug: { equals: 'detectFaces' } },
          overrideAccess: true, pagination: false, depth: 0,
        })
        return jobs.docs.filter((j) => (j.input as { photoId?: number } | null)?.photoId === photoId).length
      }
      const before = await detectFacesJobCountFor(photo.id)

      await payload.jobs.queue({ task: 'backfillFaces', input: {} })
      await payload.jobs.run({ overrideAccess: true })

      const after = await detectFacesJobCountFor(photo.id)
      expect(after).toBe(before)
    },
  )
})

describe('180-day stale-offen sweep (purgePapierkorb)', () => {
  it('expires an offen suggestion detected more than 180 days ago, leaves a recent one alone', async () => {
    const photo = await payload.create({
      collection: 'photos',
      data: { caption: 'stale-sweep', datePrecision: 'unknown', _status: 'published' },
      filePath: 'tests/fixtures/gesicht-c.jpg',
      overrideAccess: true,
    })
    createdPhotoIds.push(photo.id)
    await runFacesQueue()
    const row = await firstSuggestionFor(photo.id)

    const staleDetectedAt = new Date(Date.now() - 181 * 24 * 60 * 60 * 1000).toISOString()
    await payload.update({
      collection: 'face-suggestions', id: row.id,
      data: { detectedAt: staleDetectedAt }, overrideAccess: true,
    })
    // second, recent row on the same photo to confirm the sweep is selective, not blanket
    const recent = await payload.create({
      collection: 'face-suggestions',
      data: {
        photo: photo.id,
        boxXMin: 0.5, boxYMin: 0.5, boxXMax: 0.9, boxYMax: 0.9,
        embedding: [0.1, 0.2, 0.3],
        status: 'offen',
        detectedAt: new Date().toISOString(),
      },
      overrideAccess: true,
    })

    await payload.jobs.queue({ task: 'purgePapierkorb', input: {}, overrideAccess: true })
    await payload.jobs.run({ queue: 'default', overrideAccess: true })

    const staleReloaded = await payload.findByID({
      collection: 'face-suggestions', id: row.id, overrideAccess: true, depth: 0,
    })
    expect(staleReloaded.status).toBe('abgelehnt')
    expect(staleReloaded.embedding).toBeFalsy()

    const recentReloaded = await payload.findByID({
      collection: 'face-suggestions', id: recent.id, overrideAccess: true, depth: 0,
    })
    expect(recentReloaded.status).toBe('offen')
  })
})

describe('health reports face readiness without affecting status', () => {
  it('answers 200 and includes the faces field', async () => {
    const res = await fetch('http://localhost:3000/api/health')
    expect(res.status).toBe(200)
    const json = (await res.json()) as { status: string; faces: string }
    expect(json.status).toBe('ok')
    // Final review, M5: `expect([...]).toContain(json.faces)` is tautological — `json.faces` can
    // only ever BE one of those three literal values (the route's own return type), so this
    // passed regardless of which one actually came back and could never catch a regression. The
    // shared dev server this suite's HTTP tests run against always has real models fetched
    // (`scripts/fetch-face-models.sh`, part of `pnpm test:int`) and `FACE_DETECTION_ENABLED`
    // unset (defaults true) — the only value this can honestly be here is 'bereit'. The
    // 'Modell fehlt' branch gets its own real coverage below, in a separate process with an
    // empty models dir — the module-scope `facesCache` in the health route means that value can
    // only ever be exercised from a process that never served a request before models went
    // missing, not by mutating this shared server's env after the fact.
    expect(json.faces).toBe('bereit')
  })
})

// Final review, M5: spec §10's own testing section lists this exact case ("FACE_MODELS_DIR
// pointed at an empty directory → nothing enqueued, publish unaffected, /api/health still 200
// with faces: 'Modell fehlt'") — never implemented across Tasks 1–7.
//
// The "nothing enqueued" half needs no process trickery at all: modelsPresent()/modelsDir() read
// process.env fresh on every call (no caching), so stubbing FACE_MODELS_DIR around a
// payload.create() call in THIS process is exactly as real as doing it through a live HTTP
// upload — Photos.ts's afterChange hook and detectFacesHandler's own guard both call
// modelsPresent() at the moment they run, not at process boot.
//
// The health-route half genuinely needs a FRESH module instance: the route's own `facesCache` is
// a module-scope variable, resolved once per module lifetime on first call and never rechecked
// (src/app/api/health/route.ts's own comment explains why — it's polled on a short interval and
// neither the env flag nor the model files change at runtime). This suite's shared dev server on
// :3000 already served a health check earlier in this file with the real models present, so its
// `facesCache` is permanently 'bereit' for the rest of that process's life — nothing done from
// out here can reach into that process's memory and unresolve it. A first attempt at this test
// spawned a genuinely separate `next dev` server on another port specifically to get a fresh
// process; that turned out to be real, repeated operational trouble of its own (Next 16's
// per-project dev-server lockfile rejecting a second instance, an absolute distDir silently
// resolving INSIDE the repo via path.join instead of re-rooting, and orphaned `next-server`
// grandchild processes outliving `proc.kill()` and leaking both processes and directories) — far
// more fragility than the thing being tested is worth. `vi.resetModules()` gets the same
// "genuinely fresh module, unresolved cache" property Node gives a new process, without needing
// a new OS process at all: it clears vitest's module registry, so the next `import(...)` of the
// route (and everything it transitively imports — payload, this app's config, etc.) re-evaluates
// from scratch, with its own new `facesCache` starting at `undefined` again.
describe('degradation: FACE_MODELS_DIR pointed at an empty directory', () => {
  it('publish still succeeds, nothing is enqueued for it, and a fresh health check reports "Modell fehlt"', async () => {
    const emptyModelsDir = await mkdtemp(path.join(os.tmpdir(), 'face-models-empty-'))
    const previousModelsDir = process.env.FACE_MODELS_DIR
    process.env.FACE_MODELS_DIR = emptyModelsDir
    try {
      const photo = await payload.create({
        collection: 'photos',
        data: { caption: 'degraded', datePrecision: 'unknown', _status: 'published' },
        filePath: 'tests/fixtures/gesicht-a.jpg',
        overrideAccess: true,
      })
      createdPhotoIds.push(photo.id)

      // Nothing enqueued: Photos.ts's afterChange hook checks modelsPresent() before calling
      // enqueueDetectFaces, so no detectFaces job should exist for this photo at all — not
      // merely one that ran and no-opped.
      const jobs = await payload.find({
        collection: 'payload-jobs',
        where: { taskSlug: { equals: 'detectFaces' } },
        overrideAccess: true,
        pagination: false,
        depth: 0,
      })
      const enqueuedForThisPhoto = jobs.docs.filter(
        (j) => (j.input as { photoId?: number } | null)?.photoId === photo.id,
      )
      expect(enqueuedForThisPhoto).toHaveLength(0)

      vi.resetModules()
      const { GET } = await import('@/app/api/health/route')
      const res = await GET()
      expect(res.status).toBe(200)
      const health = (await res.json()) as { faces: string }
      expect(health.faces).toBe('Modell fehlt')
    } finally {
      if (previousModelsDir === undefined) delete process.env.FACE_MODELS_DIR
      else process.env.FACE_MODELS_DIR = previousModelsDir
      await rm(emptyModelsDir, { recursive: true, force: true })
    }
  })
})
