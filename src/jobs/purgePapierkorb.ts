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
  const findBase = {
    collection: 'photos' as const,
    where: { deletedAt: { less_than_equal: cutoff.toISOString() } },
    // overrideAccess: true because this runs as a system task, not on behalf of any particular
    // user (canReadPhoto/isAdmin would otherwise gate it, and Papierkorb entries are meant to
    // be purged regardless of who could currently see them).
    overrideAccess: true,
    limit: 0,
    depth: 0,
    req,
  }

  // Step (a): the main `photos` table's OWN deletedAt — what's actually live/public right now.
  // Anything that qualifies here is unambiguously safe to purge: no further check needed, since
  // this direct query already reflects the live row's real state.
  const { docs: liveOverdue } = await req.payload.find(findBase)
  const qualifiedIds = new Set<(typeof liveOverdue)[number]['id']>(liveOverdue.map((doc) => doc.id))

  // Step (b): H1's draft-aware find — for a drafts-enabled collection, `draft: true` routes
  // through `payload.db.queryDrafts` (collections/operations/find.js), filtering against each
  // document's LATEST version (draft or published) rather than the main table. This is what
  // catches a soft-delete that only ever made it into a draft (Payload's update path
  // (collections/operations/utilities/update.js) skips writing the main row at all whenever
  // `isSavingDraft` is true) — but that draft-aware view is now known to be a SUPERSET that can
  // include false positives too (see the guard below).
  const { docs: draftAwareOverdue } = await req.payload.find({ ...findBase, draft: true })

  // Fix round 2 (OVER-DELETION): a candidate found ONLY via the draft-aware query — i.e. not
  // already qualified via the direct main-row check above — might be a document that is fully
  // published and publicly LIVE right now (main row `_status: 'published'`, `deletedAt: null`)
  // whose only "deleted" signal sits in an abandoned, never-published draft (a curator started
  // a soft-delete, saved as draft instead of publishing, then walked away). Purging that would
  // hard-delete a currently-visible photo, files included — the exact scenario the review round
  // that added this guard was worried about. A candidate may only actually purge here if its
  // real main-row state agrees: EITHER the main row doesn't exist at all (nothing published, so
  // nothing public to protect — verified via create.js this is essentially never true in
  // practice, since `create` always writes the main row even for a draft-status document, but
  // checked anyway rather than assumed) OR the main row's OWN `deletedAt` is also set (the
  // deletion did make it to the live row, just via a path this candidate-set also happens to
  // include — in which case it was already in `qualifiedIds` from step (a) and this is a no-op
  // add). Anything else — main row exists, live, `deletedAt` unset — is left alone and logged,
  // not silently dropped, so a curator can find and finish (publish) the soft-delete themselves.
  for (const candidate of draftAwareOverdue) {
    if (qualifiedIds.has(candidate.id)) continue
    const liveDoc = await req.payload.findByID({
      collection: 'photos',
      id: candidate.id,
      overrideAccess: true,
      disableErrors: true,
      depth: 0,
      req,
    })
    if (liveDoc && !liveDoc.deletedAt) {
      req.payload.logger.warn({ msg: 'papierkorb-purge-skip-unbinned-live', id: candidate.id })
      continue
    }
    qualifiedIds.add(candidate.id)
  }

  const ids = [...qualifiedIds]

  // Fix round 1 (L2): accepted TOCTOU window. Between the qualification checks above and the
  // `delete` below, a curator could un-bin (clear `deletedAt` on) one of these ids — it would
  // still be deleted. Not closed: doing so would mean either re-checking each id's current
  // `deletedAt` inside the same DB transaction as the delete (real complexity, e.g. no
  // `payload.db.transaction`-scoped find+delete in the local API used elsewhere in this
  // codebase) or accepting a race either way. The window is milliseconds, the purge runs on a
  // fixed schedule (not continuously), and restoring something in the literal instant it's being
  // purged is already an edge case bordering on "was already too late" — the 30-day grace period
  // exists precisely so a curator has ample time to notice and un-bin well before this runs.
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
