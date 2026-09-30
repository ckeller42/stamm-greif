import { describe, it, expect, vi, afterEach } from 'vitest'
import { newErrorId, recordError, errorsLastHour, sanitizeUrl, _resetRing } from '@/lib/telemetry'

afterEach(() => { _resetRing(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('newErrorId', () => {
  it('is 6 lowercase hex chars and unique-ish', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newErrorId()))
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{6}$/)
    expect(ids.size).toBeGreaterThan(45)
  })
})

describe('sanitizeUrl', () => {
  it('redacts a bare invite path', () => {
    expect(sanitizeUrl('/einladung/abc-123')).toBe('/einladung/[token]')
  })

  it('redacts a full URL and preserves the query string', () => {
    expect(sanitizeUrl('http://x/einladung/uuid?x=1')).toBe('http://x/einladung/[token]?x=1')
  })

  it('leaves unrelated paths unchanged', () => {
    expect(sanitizeUrl('/anmelden')).toBe('/anmelden')
  })

  // C5 (consent audit): kiosk signed bearer tokens ride in ?k= / ?d= query params.
  it('redacts the kiosk session token (?k=)', () => {
    expect(sanitizeUrl('/kiosk?k=eyJzaWQ.abc.def')).toBe('/kiosk?k=[token]')
  })

  it('redacts the kiosk image/download token (?d=) and keeps other params', () => {
    expect(sanitizeUrl('/api/kiosk/image?d=eyJwaWQ.sig&x=1')).toBe('/api/kiosk/image?d=[token]&x=1')
  })

  it('redacts a token in a &-position param too', () => {
    expect(sanitizeUrl('/api/kiosk/download?foo=1&d=secrettoken')).toBe('/api/kiosk/download?foo=1&d=[token]')
  })

  it('does not touch unrelated single-letter params (e.g. ?q=)', () => {
    expect(sanitizeUrl('/suche?q=zeltlager')).toBe('/suche?q=zeltlager')
  })

  it('passes through undefined', () => {
    expect(sanitizeUrl(undefined)).toBeUndefined()
  })
})

describe('recordError / errorsLastHour', () => {
  it('counts recorded errors and emits one JSON line', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    recordError({ errorId: 'abc123', msg: 'kaputt', path: '/x' })
    expect(errorsLastHour()).toBe(1)
    const line = JSON.parse(spy.mock.calls[0][0] as string)
    expect(line).toMatchObject({ level: 'error', errorId: 'abc123', msg: 'kaputt', path: '/x' })
    expect(typeof line.time).toBe('string')
  })

  it('expires entries older than an hour', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.useFakeTimers()
    recordError({ errorId: 'aaaaaa', msg: 'alt' })
    vi.advanceTimersByTime(61 * 60 * 1000)
    recordError({ errorId: 'bbbbbb', msg: 'neu' })
    expect(errorsLastHour()).toBe(1)
  })

  it('never throws, even on unserializable input', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const cyclic: Record<string, unknown> = { errorId: 'cccccc', msg: 'zirkular' }
    cyclic.self = cyclic
    expect(() => recordError(cyclic as never)).not.toThrow()
  })

  it('caps the ring at 200', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    for (let i = 0; i < 250; i++) recordError({ errorId: 'dddddd', msg: String(i) })
    expect(errorsLastHour()).toBe(200)
  })
})
