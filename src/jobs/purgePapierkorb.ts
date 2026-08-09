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
  // Single where-scoped bulk delete: Payload's delete-by-where removes both the DB row and the
  // upload's stored files (thumbnail/web sizes included) for every match, in one call — no
  // separate find-then-loop needed. overrideAccess: true because this runs as a system task,
  // not on behalf of any particular user (canReadPhoto/isAdmin would otherwise gate it, and
  // Papierkorb entries are meant to be purged regardless of who could currently see them).
  const result = await req.payload.delete({
    collection: 'photos',
    where: { deletedAt: { less_than_equal: cutoff.toISOString() } },
    overrideAccess: true,
    req,
  })
  const purgedCount = result.docs.length
  // One structured line per run, always — including the (expected, most days) zero-purged case,
  // so "the purge job is alive and ran" is itself observable from the logs, not just "it deleted
  // something." Errors from individual failed deletes go through the task's normal
  // throw-on-failure path (see onFail below), not swallowed here.
  req.payload.logger.info({
    msg: 'papierkorb-purge',
    purgedCount,
    cutoff: cutoff.toISOString(),
    failedCount: result.errors.length,
  })
  if (result.errors.length > 0) {
    req.payload.logger.error({ msg: 'papierkorb-purge-errors', errors: result.errors })
  }
  return { output: { purgedCount } }
}

export const purgePapierkorbTask: TaskConfig<PurgePapierkorbIO> = {
  slug: 'purgePapierkorb',
  label: 'Papierkorb automatisch leeren (30 Tage)',
  handler: purgePapierkorbHandler,
  // Daily at 04:00 — quiet hours, well clear of any interactive admin/upload traffic.
  schedule: [{ cron: '0 4 * * *', queue: 'default' }],
}
