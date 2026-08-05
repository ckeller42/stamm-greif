import { describe, it, expect } from 'vitest'
import { activeInYear, overlaps, formatRange } from '@/lib/time-range'

describe('activeInYear', () => {
  it('inside closed range', () => expect(activeInYear({ von: 1987, bis: 1991 }, 1989)).toBe(true))
  it('boundaries inclusive', () => {
    expect(activeInYear({ von: 1987, bis: 1991 }, 1987)).toBe(true)
    expect(activeInYear({ von: 1987, bis: 1991 }, 1991)).toBe(true)
  })
  it('outside', () => expect(activeInYear({ von: 1987, bis: 1991 }, 1992)).toBe(false))
  it('open end -> still active', () => expect(activeInYear({ von: 2021 }, 2026)).toBe(true))
  it('open start', () => expect(activeInYear({ bis: 1990 }, 1980)).toBe(true))
  it('fully open range matches any year', () => expect(activeInYear({}, 1975)).toBe(true))
})

describe('overlaps', () => {
  it('overlapping', () => expect(overlaps({ von: 1985, bis: 1990 }, { von: 1989, bis: 1995 })).toBe(true))
  it('disjoint', () => expect(overlaps({ von: 1985, bis: 1988 }, { von: 1989, bis: 1995 })).toBe(false))
  it('open ranges overlap', () => expect(overlaps({ von: 2021 }, {})).toBe(true))
})

describe('formatRange', () => {
  it('closed', () => expect(formatRange({ von: 1987, bis: 1991 })).toBe('1987–1991'))
  it('open end', () => expect(formatRange({ von: 2021 })).toBe('seit 2021'))
  it('open start', () => expect(formatRange({ bis: 1990 })).toBe('bis 1990'))
  it('empty', () => expect(formatRange({})).toBe(''))
})
