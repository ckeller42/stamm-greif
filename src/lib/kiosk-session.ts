import type { Payload, PayloadRequest } from 'payload'

// Loads a KioskSession and returns it only if it is live (exists, not revoked, not past
// expiresAt). expiresAt on the row is authoritative; the token's own `exp` is only a stateless
// fast-path already checked by verifyKioskToken. overrideAccess:true because kiosk requests have
// no user; the row carries no photo data, only link lifecycle.
export async function loadValidSession(
  payload: Payload,
  sid: number,
  req?: PayloadRequest,
): Promise<{ id: number; expiresAt: string } | null> {
  const row = await payload
    .findByID({ collection: 'kiosk-sessions', id: sid, overrideAccess: true, disableErrors: true, depth: 0, req })
    .catch(() => null)
  if (!row) return null
  if (row.revokedAt) return null
  if (!row.expiresAt || new Date(row.expiresAt).getTime() <= Date.now()) return null
  return { id: Number(row.id), expiresAt: row.expiresAt as string }
}

// Max TTL the mint endpoint will grant. Same blank-string guard faces.ts uses for its numeric env.
export function kioskTtlHours(): number {
  const raw = process.env.KIOSK_LINK_TTL_HOURS?.trim()
  if (!raw) return 12
  const v = Number(raw)
  return Number.isFinite(v) && v > 0 ? v : 12
}
