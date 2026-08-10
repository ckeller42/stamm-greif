// Two admin-triggered tasks (no schedule — run via POST /api/payload-jobs, which is admin-only
// per payload.config.ts's jobsCollectionOverrides). Same machinery, aimed in opposite directions.
import type { TaskConfig, TaskHandler } from 'payload'
import { enqueueDetectFaces } from '@/jobs/detectFaces'
import { purgeFaceDataForPerson } from '@/hooks/purge-face-data'

type BackfillIO = { input: Record<string, never>; output: { enqueued: number } }
type ReconcileIO = { input: Record<string, never>; output: { deleted: number } }

/**
 * The owner's full-backfill decision: walk every eligible published photo and enqueue detection
 * for it. Enqueue-only — the `faces` queue's autoRun `limit` is what throttles the actual work,
 * so this returns in seconds even for a large archive and the backlog drains over hours.
 */
export const backfillFacesHandler: TaskHandler<BackfillIO> = async ({ req }) => {
  // Review (Task 6, round 2), Low: mirrors purgePapierkorbHandler's own draft-aware reasoning
  // (src/jobs/purgePapierkorb.ts) — a plain find() reads the MAIN `photos` row, which can be
  // STALE relative to the document's true current state. Concretely: a photo published earlier,
  // then "unpublished" via a `draft: true` update (`isSavingDraft` skips the main-row write
  // entirely — same mechanism purgePapierkorb's own comment documents at length) still has
  // `_status: 'published'` on its main row even though its LATEST version now says `draft`.
  // Photos' own publish-time afterChange hook never enqueues for that photo again (it only fires
  // on an actual `_status`/filename transition), so without this, a full backfill sweep would
  // keep re-enqueueing detection for a photo the archive no longer considers published, every
  // single time it's run. `draft: true` here routes through `payload.db.queryDrafts`
  // (collections/operations/find.js), which filters against each document's LATEST version
  // (draft or published) rather than the main table — directly answering "is this genuinely
  // published right now," no main-row staleness possible. Unlike purgePapierkorb's own guard,
  // this needs no second qualification pass: backfill's failure mode (wrongly skipping a photo
  // that's actually still published) is "photo waits for the next backfill run," not
  // over-deletion — there is no asymmetric harm here that would justify the two-phase dance.
  const photos = await req.payload.find({
    collection: 'photos',
    where: {
      and: [
        { _status: { equals: 'published' } },
        { deletedAt: { exists: false } },
        { hasHiddenPerson: { not_equals: true } },
      ],
    },
    draft: true,
    limit: 0,
    pagination: false,
    overrideAccess: true,
    depth: 0,
    req,
  })
  let enqueued = 0
  for (const photo of photos.docs) {
    await enqueueDetectFaces(req, photo.id)
    enqueued++
  }
  req.payload.logger.info({ msg: 'faces-backfill-enqueued', enqueued })
  return { output: { enqueued } }
}

/**
 * Restore hygiene. Face data lives in the main database and is therefore in the backups, so
 * restoring an older dump resurrects templates that a consent withdrawal had already destroyed.
 * This deletes face data for EVERY currently-hidden person — idempotent, a no-op on a healthy
 * system, and a numbered step in the restore recipe in docs/betrieb.md.
 */
export const reconcileHiddenFaceDataHandler: TaskHandler<ReconcileIO> = async ({ req }) => {
  const hidden = await req.payload.find({
    collection: 'people',
    where: { hidden: { equals: true } },
    limit: 0,
    pagination: false,
    overrideAccess: true,
    depth: 0,
    req,
  })
  let deleted = 0
  for (const person of hidden.docs) deleted += await purgeFaceDataForPerson(req, person.id)
  req.payload.logger.info({ msg: 'faces-reconcile-hidden', persons: hidden.docs.length, deleted })
  return { output: { deleted } }
}

export const backfillFacesTask: TaskConfig<BackfillIO> = {
  slug: 'backfillFaces',
  label: 'Gesichtserkennung: Archiv nachtragen',
  handler: backfillFacesHandler,
}

export const reconcileHiddenFaceDataTask: TaskConfig<ReconcileIO> = {
  slug: 'reconcileHiddenFaceData',
  label: 'Gesichtsdaten aufräumen (verborgene Personen)',
  handler: reconcileHiddenFaceDataHandler,
}
