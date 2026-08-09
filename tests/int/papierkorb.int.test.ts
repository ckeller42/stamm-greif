// Integration test: 30-day Papierkorb auto-purge (spec P2.1-B). Most of this file is Local API
// only — invokes the job system directly (payload.jobs.queue + payload.jobs.run) rather than
// waiting on the autoRun cron, same "drive it directly, don't wait on the schedule" approach
// access.int.test.ts and hidden-person.int.test.ts use for their own hooks/access checks. The
// "jobs.access.run" describe block (fix round 1, H2) is the exception — that's a real HTTP
// endpoint (`GET /api/payload-jobs/run`), so it needs the dev server running against the TEST
// database, same setup as invites.int.test.ts / heic.int.test.ts.
import { describe, it, expect, beforeAll } from 'vitest'
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
// action takes (create already exists, then a later update sets deletedAt).
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

// Fix round 1 (H1): the path a curator actually takes when soft-deleting from a photo that's
// mid-edit — "save as draft" rather than "publish". Payload's own update path
// (collections/operations/utilities/update.js) skips writing the main `photos` row entirely
// whenever `isSavingDraft` is true, landing `deletedAt` only in `_photos_v` — verified directly
// against a raw `select deleted_at from photos` after exactly this call (see the report's
// fix-round section for the transcript). `draft: true` + `_status: 'draft'` on the update is
// what triggers that path; overrideAccess: true for the same reason createSoftDeletedPhoto uses
// it above.
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

  it('hard-deletes a photo whose deletedAt was only ever saved as a draft (H1 regression)', async () => {
    // The bug this guards: a plain `where: { deletedAt: ... }` delete against the main `photos`
    // table never sees this photo at all (deletedAt lives only in `_photos_v`), so this test
    // fails against that old implementation and passes against the draft-aware
    // `payload.find({ draft: true, ... })` fix in src/jobs/purgePapierkorb.ts.
    const oldId = await createDraftSoftDeletedPhoto(new Date(Date.now() - 31 * DAY_MS))
    expect(await existsById(oldId)).toBe(true)

    await payload.jobs.queue({ task: 'purgePapierkorb', input: {}, overrideAccess: true })
    await payload.jobs.run({ queue: 'default', overrideAccess: true })

    expect(await existsById(oldId)).toBe(false)
  })
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
})
