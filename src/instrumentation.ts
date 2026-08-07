import { newErrorId, recordError, sanitizeUrl } from '@/lib/telemetry'

export function register(): void {
  // nothing to set up — onRequestError below is the hook that matters
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
