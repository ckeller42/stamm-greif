// Integration test: 30-day Papierkorb auto-purge (spec P2.1-B). Most of this file is Local API
// only — invokes the job system directly (payload.jobs.queue + payload.jobs.run) rather than
// waiting on the autoRun cron, same "drive it directly, don't wait on the schedule" approach
// access.int.test.ts and hidden-person.int.test.ts use for their own hooks/access checks. The
// "jobs.access.run" describe block (fix round 1, H2) is the exception — that's a real HTTP
// endpoint (`GET /api/payload-jobs/run`), so it needs the dev server running against the TEST
// database, same setup as invites.int.test.ts / heic.int.test.ts.
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { getPayload, type Payload } from 'payload'
import config from '@payload-config'
import path from 'node:path'

let payload: Payload
const fixture = path.resolve(process.cwd(), 'tests/fixtures/dia.jpg')
const DAY_MS = 24 * 60 * 60 * 1000

beforeAll(async () => {
  payload = await getPayload({ config: await config })
})

// Photos.ts's own beforeChange hook strips `deletedAt` on create for any request carrying a
// real `req.user` who isn't a moderator (see that hook's comment) — overrideAccess: true with
// no `user` avoids that entirely, same as the brief's "overrideAccess create + update" call.
// Two calls (create then update), not one, because Photos requires an uploaded file on create
// and setting `deletedAt` at creation time is exactly the shape a real curator's soft-delete
// action takes (create already exists, then a later update sets deletedAt). No `draft: true`
// here, so `isSavingDraft` is false and the update writes the main row directly — the third of
// the three shapes purgePapierkorb.ts's qualification rule distinguishes: published, binned via
// an ordinary (non-draft) update, main row's own `deletedAt` set directly. Caught by step (a)'s
// plain find with no further check needed — see the `it()` just below.
async function createSoftDeletedPhoto(deletedAt: Date) {
  const doc = await payload.create({
    collection: 'photos', filePath: fixture,
    data: { caption: 'Purge-Test', datePrecision: 'year', dateValue: '1980', _status: 'published' },
    overrideAccess: true,
  })
  await payload.update({
    collection: 'photos', id: doc.id, data: { deletedAt: deletedAt.toISOString() }, overrideAccess: true,
  })
  return doc.id
}

async function existsById(id: number): Promise<boolean> {
  const found = await payload.findByID({ collection: 'photos', id, overrideAccess: true, disableErrors: true })
  return Boolean(found)
}

// A soft-delete that only ever lands in a DRAFT, never published — starting from an ALREADY-
// PUBLISHED photo. E.g. a curator mid-edit who saves as draft rather than publish. Payload's own
// update path (collections/operations/utilities/update.js) skips writing the main `photos` row
// entirely whenever `isSavingDraft` is true, so `deletedAt` lands only in `_photos_v`; the main
// row stays exactly as it was before this call — still `_status: 'published'`, still fully live.
// Verified directly against a raw `select deleted_at, _status from photos` after exactly this
// call (see the report's fix-round section for the transcript). `draft: true` +
// `_status: 'draft'` on the update is what triggers that path; overrideAccess: true for the same
// reason createSoftDeletedPhoto uses it above.
//
// Used by the "over-deletion guard" test below — a PUBLISHED-and-LIVE main row with an abandoned
// binned draft on top is the one shape that genuinely must NOT purge (see
// createNeverPublishedBinnedDraft just below for the contrasting shape that must).
async function createDraftSoftDeletedPhoto(deletedAt: Date) {
  const doc = await payload.create({
    collection: 'photos', filePath: fixture,
    data: { caption: 'Purge-Test (Draft)', datePrecision: 'year', dateValue: '1980', _status: 'published' },
    overrideAccess: true,
  })
  await payload.update({
    collection: 'photos', id: doc.id, draft: true,
    data: { deletedAt: deletedAt.toISOString(), _status: 'draft' },
    overrideAccess: true,
  })
  return doc.id
}

// H1's ORIGINAL scenario, and the bulk of real Papierkorb content: a photo that was NEVER
// published — a member's upload sits as `_status: 'draft'` until a curator moderates it (see
// Photos.ts's beforeChange hook) — which a curator bins directly from that draft state, still
// without ever publishing it. `create` always writes a main row regardless of `_status`
// (collections/operations/create.js has no `isSavingDraft` guard around its `payload.db.create`
// call, unlike update), so the main row exists here too — but with `_status: 'draft'`,
// `deletedAt: null`, exactly like createDraftSoftDeletedPhoto's main row. The two are only
// distinguishable by `_status`: this one was never live/public at all, so its latest draft IS
// its authoritative state, and purging it is correct — that distinction (not `deletedAt` alone)
// is exactly what fix round 3 corrected in src/jobs/purgePapierkorb.ts's guard.
async function createNeverPublishedBinnedDraft(deletedAt: Date) {
  const doc = await payload.create({
    collection: 'photos', filePath: fixture,
    data: { caption: 'Purge-Test (Never Published)', datePrecision: 'year', dateValue: '1980', _status: 'draft' },
    overrideAccess: true,
  })
  await payload.update({
    collection: 'photos', id: doc.id, draft: true,
    data: { deletedAt: deletedAt.toISOString(), _status: 'draft' },
    overrideAccess: true,
  })
  return doc.id
}

describe('Papierkorb auto-purge', () => {
  it('hard-deletes photos soft-deleted 31 days ago, leaves 29-day-old ones untouched (published path)', async () => {
    const now = Date.now()
    const oldId = await createSoftDeletedPhoto(new Date(now - 31 * DAY_MS))
    const recentId = await createSoftDeletedPhoto(new Date(now - 29 * DAY_MS))

    expect(await existsById(oldId)).toBe(true)
    expect(await existsById(recentId)).toBe(true)

    await payload.jobs.queue({ task: 'purgePapierkorb', input: {}, overrideAccess: true })
    const runResult = await payload.jobs.run({ queue: 'default', overrideAccess: true })
    // jobStatus is keyed by job ID, not task slug — assert generically that whatever ran didn't
    // error; the real assertion is the before/after existence check below.
    for (const status of Object.values(runResult.jobStatus ?? {})) {
      expect(status.status).not.toBe('error')
    }

    expect(await existsById(oldId)).toBe(false)
    expect(await existsById(recentId)).toBe(true)

    // Cleanup: only the still-alive one needs it — the 31-day one is already gone, that's the
    // assertion above.
    await payload.delete({ collection: 'photos', id: recentId, overrideAccess: true })
  })

  it(
    'hard-deletes a photo that was NEVER published, binned directly from its draft state ' +
      '(H1, restored in fix round 3)',
    async () => {
      // Pins H1's original scenario: the bulk of real Papierkorb content is exactly this shape
      // (member upload -> draft -> curator bins it, all without ever publishing). Fix round 2's
      // first attempt at the over-deletion guard skipped this too — it checked only
      // `!liveDoc.deletedAt`, which is also true here (main row `_status: 'draft'`, `deletedAt:
      // null`, same as createDraftSoftDeletedPhoto's main row), silently re-breaking H1 for the
      // common case. Round 3 corrected the guard to also require `liveDoc._status ===
      // 'published'` before skipping — a draft-status main row was never live/public in the
      // first place, so there's nothing to protect and the latest draft's `deletedAt` is
      // authoritative. This test and the one above together pin both halves of that distinction:
      // same "main row exists, deletedAt null" shape, opposite `_status`, opposite outcome.
      const id = await createNeverPublishedBinnedDraft(new Date(Date.now() - 31 * DAY_MS))
      expect(await existsById(id)).toBe(true)

      await payload.jobs.queue({ task: 'purgePapierkorb', input: {}, overrideAccess: true })
      await payload.jobs.run({ queue: 'default', overrideAccess: true })

      expect(await existsById(id)).toBe(false)
    },
  )

  it(
    'does NOT purge a published-and-live photo even when an abandoned newer draft carries an ' +
      'old deletedAt (fix round 2, over-deletion guard)',
    async () => {
      // H1's fix (draft-aware find, LATEST-VERSION semantics) correctly surfaces this candidate
      // — but review round 2 caught that this exact data shape is dangerous: a photo that is
      // fully PUBLISHED and LIVE right now (main `photos` row: `_status: 'published'`,
      // `deletedAt: null`) whose only "deleted" signal sits in an abandoned draft a curator
      // started and never published. Purging based on the draft alone would hard-delete a
      // currently publicly-visible photo, files included. Correct behavior (src/jobs/
      // purgePapierkorb.ts): leave it alone, and log a warning with the id so a curator can find
      // and finish (publish) the abandoned soft-delete themselves. See the test above for the
      // contrasting (also main-row-deletedAt-null, but `_status: 'draft'`) shape that must
      // purge — the two together are what actually pin the guard's real behavior.
      const warnSpy = vi.spyOn(payload.logger, 'warn')
      const id = await createDraftSoftDeletedPhoto(new Date(Date.now() - 31 * DAY_MS))
      expect(await existsById(id)).toBe(true)

      await payload.jobs.queue({ task: 'purgePapierkorb', input: {}, overrideAccess: true })
      await payload.jobs.run({ queue: 'default', overrideAccess: true })

      expect(await existsById(id)).toBe(true)
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ msg: 'papierkorb-purge-skip-unbinned-live', id }),
      )

      warnSpy.mockRestore()
      await payload.delete({ collection: 'photos', id, overrideAccess: true })
    },
  )
})

describe('jobs.access.run (H2)', () => {
  const password = 'geheim123'
  let mitgliedEmail: string
  let adminEmail: string

  beforeAll(async () => {
    mitgliedEmail = `jobs-mitglied-${Date.now()}@example.com`
    adminEmail = `jobs-admin-${Date.now()}@example.com`
    await payload.create({
      collection: 'users', data: { name: 'Jobs Mitglied', email: mitgliedEmail, password, role: 'mitglied' },
      overrideAccess: true,
    })
    await payload.create({
      collection: 'users', data: { name: 'Jobs Admin', email: adminEmail, password, role: 'admin' },
      overrideAccess: true,
    })
  })

  async function loginCookie(email: string): Promise<string> {
    const res = await fetch('http://localhost:3000/api/users/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    expect(res.ok).toBe(true)
    return res.headers.get('set-cookie') ?? ''
  }

  it('mitglied is denied', async () => {
    const cookie = await loginCookie(mitgliedEmail)
    const res = await fetch('http://localhost:3000/api/payload-jobs/run', { headers: { cookie } })
    // Payload's runJobsEndpoint (queues/endpoints/run.js) itself replies 401, not the generic
    // 403 an access-controlled REST list/document route would — access denial there is a direct
    // `Response.json({...}, { status: 401 })`, not routed through Payload's usual Forbidden
    // error path. Asserted against the real endpoint rather than assumed.
    expect(res.status).toBe(401)
  })

  it('anonymous is denied', async () => {
    const res = await fetch('http://localhost:3000/api/payload-jobs/run')
    expect(res.status).toBe(401)
  })

  it('admin is allowed', async () => {
    const cookie = await loginCookie(adminEmail)
    const res = await fetch('http://localhost:3000/api/payload-jobs/run', { headers: { cookie } })
    expect(res.status).toBe(200)
  })

  // Fix round 2: pins the OTHER two H2 closures — jobsCollectionOverrides and the post-
  // buildConfig mutation of the payload-jobs-stats global — which had no committed regression
  // test of their own before this round (only `jobs.access.run`, above, was pinned). Both
  // verified against the real endpoints first (status codes below are the actual observed
  // values, not assumed): a plain access-denied write on either returns Payload's standard 403,
  // distinct from `run`'s special 401 above.
  it('mitglied cannot POST /api/payload-jobs (jobsCollectionOverrides)', async () => {
    const cookie = await loginCookie(mitgliedEmail)
    const res = await fetch('http://localhost:3000/api/payload-jobs', {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskSlug: 'purgePapierkorb', input: {} }),
    })
    expect(res.status).toBe(403)
  })

  it('mitglied cannot POST /api/globals/payload-jobs-stats (post-buildConfig global access mutation)', async () => {
    const cookie = await loginCookie(mitgliedEmail)
    const res = await fetch('http://localhost:3000/api/globals/payload-jobs-stats', {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ stats: {} }),
    })
    expect(res.status).toBe(403)
  })
})
