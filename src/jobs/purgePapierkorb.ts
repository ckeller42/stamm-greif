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

  // Fix round 2 (OVER-DELETION), corrected in round 3: a candidate found ONLY via the
  // draft-aware query — i.e. not already qualified via the direct main-row check above — needs
  // one more check, but round 2's own first attempt at that check (`liveDoc && !liveDoc.
  // deletedAt` → skip) was ITSELF wrong, and re-broke H1 for the single most common Papierkorb
  // shape: a member's upload that was NEVER published (main row `_status: 'draft'` from
  // `create`, which always writes a main row — collections/operations/create.js — regardless of
  // draft status) which a curator then bins via a draft update. That main row's `deletedAt` is
  // also null (`isSavingDraft` skips the main-row write on that update, same as any draft-only
  // change — this is H1's original finding), so round 2's check saw "main row exists,
  // `deletedAt` unset" and skipped it forever — but there is no publicly-live state to protect
  // there at all: the doc was never published, so its latest DRAFT genuinely is its only
  // authoritative state, and that draft says deleted.
  //
  // The distinction round 2 was missing is `_status`, not just `deletedAt`. There is only a
  // live/public state worth protecting when the main row is PUBLISHED:
  //   - main row `_status: 'published'`, `deletedAt` unset → genuinely live and unbinned (a
  //     curator started a soft-delete, saved as draft instead of publishing, then walked away)
  //     → skip + warn. This is round 2's actual target scenario, still caught correctly.
  //   - main row `_status: 'draft'` (never published, or explicitly unpublished) → nothing
  //     public to protect regardless of the main row's `deletedAt` — the latest draft IS the
  //     doc's authoritative state → purge. This restores H1.
  //   - main row absent entirely → nothing published, nothing to protect → purge (checked
  //     defensively; per create.js this is essentially never true in practice, since `create`
  //     always writes the main row even for a draft-status document).
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
    if (liveDoc && !liveDoc.deletedAt && liveDoc._status === 'published') {
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

  // Speicherbegrenzung (Art. 5 Abs. 1 lit. e): an `offen` suggestion nobody ever reviewed is a
  // biometric template for an unidentified person. After 180 days it loses the template and
  // becomes a tombstone, which still stops a re-run resurrecting the same box.
  //
  // Final review, L13: this sweep's own failure must not suppress the `papierkorb-purge` summary
  // line below — betrieb.md's own "Prüfen, ob er läuft" instructions tell operators to grep for
  // exactly that line daily, and a thrown error ahead of it (the original round-2 H1 fix's
  // ordering) would make a bad day for face-suggestions expiry look identical to "the purge job
  // didn't run at all," hiding the one thing that DID succeed (the actual Papierkorb purge above,
  // already computed by this point). So: catch around the sweep entirely (both a thrown error
  // from the update call itself and a partial-failure result count as "the sweep failed"), log
  // that failure, EMIT the summary line regardless, and only THEN throw — a distinct error,
  // clearly attributable to the sweep and not the purge — so the job still fails visibly
  // (Payload's own retry/error-log handling applies) without costing the summary line its
  // baseline "the purge job is alive and ran" signal.
  const staleCutoff = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString()
  let staleExpireError: Error | undefined
  try {
    const stale = await req.payload.update({
      collection: 'face-suggestions',
      where: {
        and: [
          { status: { equals: 'offen' } },
          {
            // Review (Task 6, round 2), Low: `detectedAt` is always set by detectFacesHandler on
            // the normal path, but SQL `less_than` never matches NULL — a row that somehow lacks
            // it (a manually-created row, a future code path that forgets to set it) would
            // silently never expire and leak its embedding forever. `createdAt` is Payload's own
            // automatic timestamp (every collection gets one unless `timestamps: false`, which
            // FaceSuggestions doesn't set) — it always exists, so it's the fallback cutoff for
            // exactly the rows `detectedAt` can't answer for.
            or: [
              { detectedAt: { less_than: staleCutoff } },
              { and: [{ detectedAt: { exists: false } }, { createdAt: { less_than: staleCutoff } }] },
            ],
          },
        ],
      },
      data: { status: 'abgelehnt', embedding: null },
      overrideAccess: true,
      req,
    })
    // Review (Task 6, round 2), H1 (same class as purge-face-data.ts, lower stakes: a missed
    // expiry just means a stale template lingers one more day, not a consent breach): a bulk
    // `update({ where })` never rejects on a per-row failure, it resolves with that row's error
    // pushed onto `errors[]`. Reading only `docs.length` would silently under-report (or fully
    // hide, if every row failed) an incomplete sweep.
    if (stale.errors.length > 0) {
      staleExpireError = new Error(
        `face-suggestions-expire-incomplete: ${stale.errors.length} row(s) failed to expire: ` +
          stale.errors.map((e) => e.message).join('; '),
      )
    }
    if (stale.docs.length > 0) {
      req.payload.logger.info({ msg: 'face-suggestions-expired', expired: stale.docs.length })
    }
  } catch (err) {
    staleExpireError = err instanceof Error ? err : new Error(String(err))
  }
  if (staleExpireError) {
    req.payload.logger.error({
      msg: 'face-suggestions-expire-failed',
      error: staleExpireError.message,
    })
  }

  // One structured line per run, always — including the (expected, most days) zero-purged case,
  // so "the purge job is alive and ran" is itself observable from the logs, not just "it deleted
  // something." Emitted even when the sweep above failed (see the L13 comment on that block).
  req.payload.logger.info({
    msg: 'papierkorb-purge',
    purgedCount,
    cutoff: cutoff.toISOString(),
    failedCount,
  })

  if (staleExpireError) {
    throw staleExpireError
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
