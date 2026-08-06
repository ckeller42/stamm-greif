import { describe, it, expect, vi, afterEach } from 'vitest'
import { newErrorId, recordError, errorsLastHour, _resetRing } from '@/lib/telemetry'

afterEach(() => { _resetRing(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('newErrorId', () => {
  it('is 6 lowercase hex chars and unique-ish', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newErrorId()))
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{6}$/)
    expect(ids.size).toBeGreaterThan(45)
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
