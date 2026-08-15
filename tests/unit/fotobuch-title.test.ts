import { describe, it, expect } from 'vitest'
import { fotobuchTitle, fotobuchDateRange } from '@/lib/fotobuch-title'

describe('fotobuchTitle', () => {
  it('is the subject name, umlauts intact', () => {
    expect(fotobuchTitle({ type: 'person', name: 'Jürgen Müller' })).toBe('Jürgen Müller')
  })

  it('works for event and series subjects too', () => {
    expect(fotobuchTitle({ type: 'event', name: 'Sommerlager' })).toBe('Sommerlager')
    expect(fotobuchTitle({ type: 'series', name: 'Pfingstlager', years: [] })).toBe('Pfingstlager')
  })
})

describe('fotobuchDateRange', () => {
  it('event: fuzzy-date label', () => {
    expect(fotobuchDateRange({ type: 'event', name: 'Sommerlager', datePrecision: 'year', dateValue: '1989' })).toBe('1989')
    expect(fotobuchDateRange({ type: 'event', name: 'x', datePrecision: 'exact', dateValue: '1989-08-12' })).toBe('12.08.1989')
    expect(fotobuchDateRange({ type: 'event', name: 'x', datePrecision: 'decade', dateValue: '1980' })).toBe('1980er Jahre')
  })

  it('event: unknown precision or missing/garbage value falls back to "Datum unbekannt"', () => {
    expect(fotobuchDateRange({ type: 'event', name: 'x', datePrecision: 'unknown', dateValue: null })).toBe(
      'Datum unbekannt',
    )
    expect(fotobuchDateRange({ type: 'event', name: 'x' })).toBe('Datum unbekannt')
    expect(fotobuchDateRange({ type: 'event', name: 'x', datePrecision: 'exact', dateValue: 'not-a-date' })).toBe(
      'Datum unbekannt',
    )
    expect(fotobuchDateRange({ type: 'event', name: 'x', datePrecision: 'decade', dateValue: '1987' })).toBe(
      'Datum unbekannt',
    )
  })

  it('series: min–max of member-event years', () => {
    expect(fotobuchDateRange({ type: 'series', name: 'Sommerlager', years: [1990, 1985, 2025] })).toBe('1985–2025')
    expect(fotobuchDateRange({ type: 'series', name: 'x', years: [1999] })).toBe('1999')
    expect(fotobuchDateRange({ type: 'series', name: 'x', years: [] })).toBe('')
  })

  it('series: ignores non-finite years and tolerates unsorted input', () => {
    expect(fotobuchDateRange({ type: 'series', name: 'x', years: [2010, NaN, 1995, Infinity] })).toBe('1995–2010')
  })

  it('person: birth year or empty', () => {
    expect(fotobuchDateRange({ type: 'person', name: 'x', birthYear: 1974 })).toBe('* 1974')
    expect(fotobuchDateRange({ type: 'person', name: 'x' })).toBe('')
    expect(fotobuchDateRange({ type: 'person', name: 'x', birthYear: null })).toBe('')
  })
})
