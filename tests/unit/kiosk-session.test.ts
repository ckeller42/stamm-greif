import { describe, it, expect, beforeEach, vi } from 'vitest'
import { loadValidSession, kioskTtlHours } from '@/lib/kiosk-session'

const future = () => new Date(Date.now() + 60_000).toISOString()

describe('loadValidSession', () => {
  const base = { id: 7, revokedAt: null, expiresAt: future() } as any

  it('returns a live session row', async () => {
    const payload = {
      findByID: vi.fn(async (args: any) => ({ ...base })),
    } as any
    const out = await loadValidSession(payload, 7)
    expect(out).toEqual({ id: 7, expiresAt: base.expiresAt })
    // kiosk requests have no user — the row must be read with overrideAccess
    expect(payload.findByID).toHaveBeenCalledWith(
      expect.objectContaining({ collection: 'kiosk-sessions', id: 7, overrideAccess: true }),
    )
  })

  it('rejects when the row is missing (findByID error -> null)', async () => {
    const payload = {
      findByID: vi.fn(async () => {
        throw new Error('not found')
      }),
    } as any
    expect(await loadValidSession(payload, 7)).toBeNull()
  })

  it('rejects a revoked session even though it is unexpired', async () => {
    const payload = {
      findByID: vi.fn(async () => ({ ...base, revokedAt: new Date().toISOString() })),
    } as any
    expect(await loadValidSession(payload, 7)).toBeNull()
  })

  it('rejects a session with no expiresAt (no expiry = not valid)', async () => {
    const payload = { findByID: vi.fn(async () => ({ ...base, expiresAt: undefined })) } as any
    expect(await loadValidSession(payload, 7)).toBeNull()
  })

  it('rejects an expired session', async () => {
    const payload = {
      findByID: vi.fn(async () => ({ ...base, expiresAt: new Date(Date.now() - 1).toISOString() })),
    } as any
    expect(await loadValidSession(payload, 7)).toBeNull()
  })

  it('passes the optional req through', async () => {
    const req = { user: null } as any
    const payload = { findByID: vi.fn(async () => ({ ...base })) } as any
    await loadValidSession(payload, 7, req)
    expect(payload.findByID).toHaveBeenCalledWith(
      expect.objectContaining({ req }),
    )
  })
})

describe('kioskTtlHours', () => {
  const KEY = 'KIOSK_LINK_TTL_HOURS'
  beforeEach(() => {
    delete process.env[KEY]
  })

  it('defaults to 12h when unset or blank', () => {
    expect(kioskTtlHours()).toBe(12)
    process.env[KEY] = '   '
    expect(kioskTtlHours()).toBe(12)
  })

  it('accepts a positive number', () => {
    process.env[KEY] = '24'
    expect(kioskTtlHours()).toBe(24)
    process.env[KEY] = '1.5'
    expect(kioskTtlHours()).toBe(1.5)
  })

  it('falls back to 12h for non-numeric or non-positive values', () => {
    process.env[KEY] = 'soon'
    expect(kioskTtlHours()).toBe(12)
    process.env[KEY] = '0'
    expect(kioskTtlHours()).toBe(12)
    process.env[KEY] = '-5'
    expect(kioskTtlHours()).toBe(12)
  })
})
