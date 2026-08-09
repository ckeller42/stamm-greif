// Spec §5 MVP line "soft-delete (Papierkorb, 30 days)" — this is the auto-purge half that never
// got built: photos soft-deleted (Photos.deletedAt set) more than PURGE_WINDOW_DAYS ago get
// hard-deleted (DB row + stored files) automatically, in-process, via Payload 3's jobs system.
//
// API shape verified directly against node_modules/payload 3.87.0's .d.ts files (no public docs
// consulted): TaskConfig/TaskHandler from 'payload' (queues/config/types/taskTypes.d.ts),
// AutorunCronConfig + ScheduleConfig from queues/config/types/index.d.ts. `schedule` on the task
// (a ScheduleConfig[]) is what actually *enqueues* a job on the given cron; `jobs.autoRun` on
// the top-level config (wired in payload.config.ts) is the separate thing that *runs* whatever
// is sitting in that queue — both are required, and payload's own type doc comment on `autoRun`
// says so explicitly ("does not queue new jobs - only runs jobs that are already... queued").
import type { TaskConfig, TaskHandler } from 'payload'
import { purgeCutoff } from '@/lib/papierkorb'

type PurgePapierkorbIO = {
  input: Record<string, never>
  output: { purgedCount: number }
}

export const purgePapierkorbHandler: TaskHandler<PurgePapierkorbIO> = async ({ req }) => {
  const cutoff = purgeCutoff()

  // Fix round 1 (H1): a plain `where: { deletedAt: ... }` delete against the main `photos`
  // table silently misses a whole class of soft-deletes. With versions.drafts enabled,
  // Payload's own update path (node_modules/payload/dist/collections/operations/utilities/
  // update.js) skips `db.updateOne` on the main row entirely whenever `isSavingDraft` is true —
  // i.e. whenever a curator's edit ends in "save as draft" rather than "publish", *including*
  // an edit that only sets `deletedAt`. That write lands solely in `_photos_v` (the versions
  // table); `photos.deleted_at` stays NULL. Verified empirically (see the report's fix-round
  // section, and tests/int/papierkorb.int.test.ts's draft-path case) with a raw
  // `select deleted_at from photos` after exactly such an update.
  //
  // `payload.find({ draft: true, where })` is the fix: for a drafts-enabled collection this
  // routes through `payload.db.queryDrafts` (collections/operations/find.js), which filters
  // against each document's LATEST version — draft or published, whichever is current — not
  // the main table. That's both correct (the version *is* the doc's current state, which is
  // exactly what "is this soft-deleted" should mean) and confirmed empirically to surface
  // draft-only deletedAt values the plain main-table query cannot see.
  //
  // Two-step (find ids, then delete-by-id) rather than a single draft-aware delete because
  // Payload's `delete` operation has no `draft` option — deletion always removes the row (and
  // its whole version history) regardless of draft/published state, so a plain by-id delete on
  // the ids this find surfaces is correct and complete.
  const { docs } = await req.payload.find({
    collection: 'photos',
    draft: true,
    where: { deletedAt: { less_than_equal: cutoff.toISOString() } },
    // overrideAccess: true because this runs as a system task, not on behalf of any particular
    // user (canReadPhoto/isAdmin would otherwise gate it, and Papierkorb entries are meant to
    // be purged regardless of who could currently see them).
    overrideAccess: true,
    limit: 0,
    depth: 0,
    req,
  })
  const ids = docs.map((doc) => doc.id)

  // Fix round 1 (L2): accepted TOCTOU window. Between the `find` above and the `delete` below,
  // a curator could un-bin (clear `deletedAt` on) one of these ids — it would still be deleted.
  // Not closed: doing so would mean either re-checking each id's current `deletedAt` inside the
  // same DB transaction as the delete (real complexity, e.g. no `payload.db.transaction`-scoped
  // find+delete in the local API used elsewhere in this codebase) or accepting a race either
  // way. The window is milliseconds, the purge runs once daily on a fixed schedule (not
  // continuously), and restoring something in the literal instant it's being purged is already
  // an edge case bordering on "was already too late" — the 30-day grace period exists precisely
  // so a curator has ample time to notice and un-bin well before this runs.
  let purgedCount = 0
  let failedCount = 0
  if (ids.length > 0) {
    const result = await req.payload.delete({
      collection: 'photos',
      where: { id: { in: ids } },
      overrideAccess: true,
      req,
    })
    purgedCount = result.docs.length
    failedCount = result.errors.length
    if (result.errors.length > 0) {
      req.payload.logger.error({ msg: 'papierkorb-purge-errors', errors: result.errors })
    }
  }

  // One structured line per run, always — including the (expected, most days) zero-purged case,
  // so "the purge job is alive and ran" is itself observable from the logs, not just "it deleted
  // something."
  req.payload.logger.info({
    msg: 'papierkorb-purge',
    purgedCount,
    cutoff: cutoff.toISOString(),
    failedCount,
  })
  return { output: { purgedCount } }
}

export const purgePapierkorbTask: TaskConfig<PurgePapierkorbIO> = {
  slug: 'purgePapierkorb',
  label: 'Papierkorb automatisch leeren (30 Tage)',
  handler: purgePapierkorbHandler,
  // Daily at 04:00 — quiet hours, well clear of any interactive admin/upload traffic.
  schedule: [{ cron: '0 4 * * *', queue: 'default' }],
}
