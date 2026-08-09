// Integration test: 30-day Papierkorb auto-purge (spec P2.1-B). Local API only — invokes the
// job system directly (payload.jobs.queue + payload.jobs.run) rather than waiting on the
// autoRun cron, same "drive it directly, don't wait on the schedule" approach access.int.test.ts
// and hidden-person.int.test.ts use for their own hooks/access checks.
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

describe('Papierkorb auto-purge', () => {
  it('hard-deletes photos soft-deleted 31 days ago, leaves 29-day-old ones untouched', async () => {
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
})
