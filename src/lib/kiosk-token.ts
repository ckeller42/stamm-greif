import crypto from 'crypto'

// P2.4 signed kiosk links + per-photo download/image tokens. Three token kinds share one HMAC
// primitive:
//   session  { sid, exp }                     — the /kiosk?k= link
//   download { sid, pid, exp, kind:'download' } — one per photo QR, /api/kiosk/download?d=
//   image    { sid, pid, exp, kind:'image' }    — one per slide <img>, /api/kiosk/image?d=
// download and image share the same {sid,pid,exp} shape (both scope a session to one photo), so
// the payload itself carries an explicit `kind` marker to keep them from being interchangeable —
// without it, a slideshow image token would also verify at the download endpoint (and serve the
// full-resolution original instead of the inline web derivative it was scoped for) and vice
// versa. verifyKioskToken checks this marker AS WELL AS the caller-requested kind, so a token
// only ever verifies for the one endpoint it was minted for.
// The signing key is DERIVED from PAYLOAD_SECRET, never the secret itself, so kiosk signatures
// are not interchangeable with any other use of the secret and carry a version handle ('kiosk-v1')
// for a future rotation that leaves member logins untouched.
export type KioskTokenPayload =
  | { sid: number; exp: number }
  | { sid: number; pid: number; exp: number; kind: 'download' }
  | { sid: number; pid: number; exp: number; kind: 'image' }

function kioskKey(): Buffer {
  const secret = process.env.PAYLOAD_SECRET
  if (!secret) throw new Error('PAYLOAD_SECRET is required')
  return crypto.createHmac('sha256', secret).update('kiosk-v1').digest()
}

function sign(payloadB64: string): string {
  return crypto.createHmac('sha256', kioskKey()).update(payloadB64).digest('base64url')
}

export function signKioskToken(payload: KioskTokenPayload): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${payloadB64}.${sign(payloadB64)}`
}

// Verification order: shape → constant-time signature compare → expiry → kind. Never throws; any
// malformed/forged/expired/wrong-kind input returns null, which every caller maps to a 404 / the
// graceful invalid state. Statless (no DB) — this is the cheap, attacker-facing fast path;
// revocation and consent are checked by callers AFTER a token verifies.
export function verifyKioskToken(
  token: string,
  kind: 'session' | 'download' | 'image',
): KioskTokenPayload | null {
  try {
    const dot = token.indexOf('.')
    if (dot <= 0) return null
    const payloadB64 = token.slice(0, dot)
    const sigB64 = token.slice(dot + 1)
    const expected = Buffer.from(sign(payloadB64), 'utf8')
    const got = Buffer.from(sigB64, 'utf8')
    if (expected.length !== got.length) return null
    if (!crypto.timingSafeEqual(expected, got)) return null
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as Record<string, unknown>
    if (typeof payload.sid !== 'number' || typeof payload.exp !== 'number') return null
    if (payload.exp <= Date.now()) return null
    const hasPid = typeof payload.pid === 'number'
    if (kind === 'session') {
      // A session token never carries a pid; a download/image token always does — so this alone
      // already keeps session tokens from being accepted anywhere but /kiosk?k=.
      if (hasPid) return null
      return payload as KioskTokenPayload
    }
    // download/image: requires a pid AND the payload's own `kind` marker to match the endpoint
    // asking — this is what keeps the two pid-shaped kinds from being interchangeable with each
    // other (see the type comment above), not just with session.
    if (!hasPid || payload.kind !== kind) return null
    return payload as KioskTokenPayload
  } catch {
    return null
  }
}
