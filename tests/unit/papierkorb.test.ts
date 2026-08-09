import { describe, it, expect } from 'vitest'
import { purgeCutoff, isDueForPurge, PURGE_WINDOW_DAYS } from '@/lib/papierkorb'

const NOW = new Date('2026-08-09T12:00:00.000Z')
const DAY_MS = 24 * 60 * 60 * 1000

describe('purgeCutoff', () => {
  it('defaults to 30 days before now', () => {
    expect(PURGE_WINDOW_DAYS).toBe(30)
    expect(purgeCutoff(NOW).getTime()).toBe(NOW.getTime() - 30 * DAY_MS)
  })

  it('honors a custom window', () => {
    expect(purgeCutoff(NOW, 7).getTime()).toBe(NOW.getTime() - 7 * DAY_MS)
  })
})

describe('isDueForPurge', () => {
  it('31 days ago -> due', () => {
    const deletedAt = new Date(NOW.getTime() - 31 * DAY_MS).toISOString()
    expect(isDueForPurge(deletedAt, NOW)).toBe(true)
  })

  it('29 days ago -> not yet due', () => {
    const deletedAt = new Date(NOW.getTime() - 29 * DAY_MS).toISOString()
    expect(isDueForPurge(deletedAt, NOW)).toBe(false)
  })

  it('exactly 30 days ago -> due (boundary is inclusive)', () => {
    const deletedAt = new Date(NOW.getTime() - 30 * DAY_MS).toISOString()
    expect(isDueForPurge(deletedAt, NOW)).toBe(true)
  })

  it('null/undefined deletedAt -> never due', () => {
    expect(isDueForPurge(null, NOW)).toBe(false)
    expect(isDueForPurge(undefined, NOW)).toBe(false)
  })

  it('garbage date string -> not due (fails closed, never crashes)', () => {
    expect(isDueForPurge('not-a-date', NOW)).toBe(false)
  })

  it('accepts a Date instance directly, not just ISO strings', () => {
    const deletedAt = new Date(NOW.getTime() - 45 * DAY_MS)
    expect(isDueForPurge(deletedAt, NOW)).toBe(true)
  })
})
