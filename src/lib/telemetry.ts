import crypto from 'crypto'

// One JSON line per error to stdout/stderr; Docker's json-file driver is the storage and
// `scripts/errors.sh` the query tool. The ring buffer only feeds /api/health's
// errorsLastHour — process-local by design (resets on restart; history lives in the logs).
const RING_MAX = 200
const HOUR_MS = 60 * 60 * 1000
let ring: { time: number }[] = []

export function newErrorId(): string {
  return crypto.randomBytes(3).toString('hex')
}

export function recordError(entry: { errorId: string; msg: string; [k: string]: unknown }): void {
  try {
    const now = Date.now()
    ring = ring.filter((e) => now - e.time < HOUR_MS)
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
  ring = ring.filter((e) => now - e.time < HOUR_MS)
  return ring.length
}

/** Test hook only. */
export function _resetRing(): void {
  ring = []
}
