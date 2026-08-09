import { newErrorId, recordError, sanitizeUrl } from '@/lib/telemetry'

export async function register(): Promise<void> {
  // Fix round 1 (H5): Payload's job-system cron (jobs.autoRun — what actually triggers the
  // daily Papierkorb purge, per src/jobs/purgePapierkorb.ts) only initializes on a
  // `getPayload({ cron: true })` call (payload/dist/index.js's `_initializeCrons`, gated behind
  // `options.cron`). Verified directly: only @payloadcms/next's own request-handling entry
  // points (auth/login.js, utilities/initReq.js, etc.) ever pass `cron: true` — nothing else
  // does, including this app's own frontend page renders. Payload caches its instance as a
  // singleton per process, so whichever call happens to init it first wins; a freshly restarted
  // container that receives zero admin/API traffic would otherwise never start the cron at all.
  // `register()` is Next.js's dedicated "runs exactly once, at process boot, regardless of
  // traffic" hook — this guarantees the cron starts on every boot.
  //
  // Guarded to the Node runtime: Next.js also compiles an Edge variant of this file (hence the
  // pre-existing "Node.js module... not supported in Edge Runtime" build warning for
  // `telemetry.ts`'s `crypto` import below) — Payload itself is Node-only (pg, crypto, fs), so
  // this must not attempt to run there.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    try {
      const [{ getPayload }, { default: config }] = await Promise.all([import('payload'), import('@payload-config')])
      await getPayload({ config, cron: true })
    } catch (err) {
      // Must never crash server boot — e.g. the DB briefly unreachable at container start. The
      // cron will still start on the first normal admin/API request via @payloadcms/next's own
      // `cron: true` calls; this is a best-effort "start it as early as possible", not the only
      // path to it ever starting.
      const e = err instanceof Error ? err : new Error(String(err))
      recordError({ errorId: newErrorId(), msg: e.message, stack: e.stack, source: 'instrumentation-register' })
    }
  }
}

// Next.js calls this for every unhandled server error (pages, route handlers, server actions).
// Payload API errors are additionally handled (with response mutation) by the afterError hook
// in payload.config.ts; both funnels share recordError, so /api/health counts everything.
export function onRequestError(
  err: unknown,
  request: { path: string; method: string },
  context: { routerKind: string; routePath: string; routeType: string },
): void {
  const e = err instanceof Error ? err : new Error(String(err))
  recordError({
    errorId: newErrorId(),
    msg: e.message,
    stack: e.stack,
    path: sanitizeUrl(request.path),
    method: request.method,
    routeType: context.routeType,
    routePath: context.routePath,
    source: 'onRequestError',
  })
}
