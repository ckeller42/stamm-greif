import { describe, it, expect, beforeEach } from 'vitest'
import { signKioskToken, verifyKioskToken } from '@/lib/kiosk-token'

beforeEach(() => { process.env.PAYLOAD_SECRET = 'test-secret-abc' })

describe('kiosk-token', () => {
  it('round-trips a session token', () => {
    const t = signKioskToken({ sid: 42, exp: Date.now() + 60_000 })
    const v = verifyKioskToken(t, 'session')
    expect(v).toMatchObject({ sid: 42 })
  })

  it('round-trips a download token', () => {
    const t = signKioskToken({ sid: 1, pid: 7, exp: Date.now() + 60_000 })
    expect(verifyKioskToken(t, 'download')).toMatchObject({ sid: 1, pid: 7 })
  })

  it('rejects an expired token', () => {
    const t = signKioskToken({ sid: 1, exp: Date.now() - 1 })
    expect(verifyKioskToken(t, 'session')).toBeNull()
  })

  it('rejects a tampered payload', () => {
    const t = signKioskToken({ sid: 1, exp: Date.now() + 60_000 })
    const [p, s] = t.split('.')
    const forged = Buffer.from(JSON.stringify({ sid: 999, exp: Date.now() + 60_000 })).toString('base64url')
    expect(verifyKioskToken(`${forged}.${s}`, 'session')).toBeNull()
    expect(verifyKioskToken(`${p}.deadbeef`, 'session')).toBeNull()
  })

  it('rejects a wrong-secret signature', () => {
    const t = signKioskToken({ sid: 1, exp: Date.now() + 60_000 })
    process.env.PAYLOAD_SECRET = 'a-different-secret'
    expect(verifyKioskToken(t, 'session')).toBeNull()
  })

  it('rejects a kind mismatch (download token read as session and vice-versa)', () => {
    const dl = signKioskToken({ sid: 1, pid: 7, exp: Date.now() + 60_000 })
    expect(verifyKioskToken(dl, 'session')).toBeNull()
    const se = signKioskToken({ sid: 1, exp: Date.now() + 60_000 })
    expect(verifyKioskToken(se, 'download')).toBeNull()
  })

  it('never throws on garbage input', () => {
    for (const g of ['', 'x', 'a.b.c', '...', 'notbase64.@@@']) {
      expect(() => verifyKioskToken(g, 'session')).not.toThrow()
      expect(verifyKioskToken(g, 'session')).toBeNull()
    }
  })
})
