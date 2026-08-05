import { describe, it, expect } from 'vitest'
import { parseFuzzyDate } from '@/lib/fuzzy-date'

describe('parseFuzzyDate', () => {
  it('exact date -> full sortKey and German label', () => {
    expect(parseFuzzyDate({ precision: 'exact', value: '1989-07-14' }))
      .toEqual({ sortKey: 19890714, label: '14.07.1989' })
  })
  it('year -> YYYY0000 sortKey', () => {
    expect(parseFuzzyDate({ precision: 'year', value: '1989' }))
      .toEqual({ sortKey: 19890000, label: '1989' })
  })
  it('decade -> first year sortKey, "er Jahre" label', () => {
    expect(parseFuzzyDate({ precision: 'decade', value: '1980' }))
      .toEqual({ sortKey: 19800000, label: '1980er Jahre' })
  })
  it('decade not ending in 0 (e.g. 1987) -> unknown', () => {
    expect(parseFuzzyDate({ precision: 'decade', value: '1987' }))
      .toEqual({ sortKey: null, label: 'Datum unbekannt' })
  })
  it('unknown -> null sortKey', () => {
    expect(parseFuzzyDate({ precision: 'unknown' }))
      .toEqual({ sortKey: null, label: 'Datum unbekannt' })
  })
  it('invalid exact value -> treated as unknown', () => {
    expect(parseFuzzyDate({ precision: 'exact', value: 'kaputt' }))
      .toEqual({ sortKey: null, label: 'Datum unbekannt' })
  })
  it('invalid month (13) -> treated as unknown', () => {
    expect(parseFuzzyDate({ precision: 'exact', value: '1989-13-45' }))
      .toEqual({ sortKey: null, label: 'Datum unbekannt' })
  })
  it('invalid day (30 Feb) -> treated as unknown', () => {
    expect(parseFuzzyDate({ precision: 'exact', value: '1989-02-30' }))
      .toEqual({ sortKey: null, label: 'Datum unbekannt' })
  })
  it('valid leap year Feb 29 -> full sortKey and German label', () => {
    expect(parseFuzzyDate({ precision: 'exact', value: '2020-02-29' }))
      .toEqual({ sortKey: 20200229, label: '29.02.2020' })
  })
})
