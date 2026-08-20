import crypto from 'crypto'

// One JSON line per error to stdout/stderr; Docker's json-file driver is the storage and
// `scripts/errors.sh` the query tool. The ring buffer only feeds /api/health's
// errorsLastHour — process-local by design (resets on restart; history lives in the logs).
const RING_MAX = 200
const HOUR_MS = 60 * 60 * 1000

// The instrumentation entry gets its own bundled copy of this module in the standalone build,
// so module-level state would split the ring between funnels. globalThis makes it one ring
// per process regardless of how many chunks carry this module.
const RING_KEY = Symbol.for('stamm-greif.telemetry.ring')
type Ring = { time: number }[]
const g = globalThis as { [k: symbol]: Ring | undefined }
function getRing(): Ring {
  return (g[RING_KEY] ??= [])
}

export function newErrorId(): string {
  return crypto.randomBytes(3).toString('hex')
}

// Redacts bearer tokens from logged URLs/paths so a leaked log line can't be replayed. Covers
// both token shapes this app puts in URLs:
//   • invite tokens in the path — `/einladung/<token>`
//   • kiosk signed tokens in the query — `?k=<token>` (the /kiosk session link) and `?d=<token>`
//     (per-photo /api/kiosk/image and /api/kiosk/download), each a live-consent-checked bearer.
// One combined pattern: group 1 is the prefix (kept), the token that follows it becomes [token].
export function sanitizeUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined
  return url.replace(/(\/einladung\/|[?&](?:k|d)=)[^/?#&]+/g, '$1[token]')
}

export function recordError(entry: { errorId: string; msg: string; [k: string]: unknown }): void {
  try {
    const now = Date.now()
    const ring = (g[RING_KEY] = getRing().filter((e) => now - e.time < HOUR_MS))
    if (ring.length >= RING_MAX) ring.shift()
    ring.push({ time: now })
    let line: string
    try {
      line = JSON.stringify({ level: 'error', time: new Date(now).toISOString(), ...entry })
    } catch {
      // unserializable context (circular refs etc.) — degrade to the two safe fields
      line = JSON.stringify({ level: 'error', time: new Date(now).toISOString(), errorId: entry.errorId, msg: String(entry.msg) })
    }
    console.error(line)
  } catch {
    // telemetry must never take the app down
  }
}

export function errorsLastHour(): number {
  const now = Date.now()
  const ring = (g[RING_KEY] = getRing().filter((e) => now - e.time < HOUR_MS))
  return ring.length
}

/** Test hook only. */
export function _resetRing(): void {
  g[RING_KEY] = []
}
