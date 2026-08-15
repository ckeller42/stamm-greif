import { parseFuzzyDate, type FuzzyPrecision } from '@/lib/fuzzy-date'

export type FotobuchSubject =
  | { type: 'event'; name: string; datePrecision?: string | null; dateValue?: string | null }
  | { type: 'series'; name: string; years: number[] }
  | { type: 'person'; name: string; birthYear?: number | null }

export function fotobuchTitle(s: FotobuchSubject): string {
  return s.name
}

// Subtitle under the cover title (spec §6.2). Reuses parseFuzzyDate so an event's label reads
// exactly as it does on the event page. Series range is derived from its member events' years
// (computed by the caller, which has the events loaded).
export function fotobuchDateRange(s: FotobuchSubject): string {
  switch (s.type) {
    case 'event':
      return parseFuzzyDate({ precision: (s.datePrecision ?? 'unknown') as FuzzyPrecision, value: s.dateValue ?? null }).label
    case 'series': {
      const ys = s.years.filter((y) => Number.isFinite(y))
      if (ys.length === 0) return ''
      const min = Math.min(...ys)
      const max = Math.max(...ys)
      return min === max ? String(min) : `${min}–${max}`
    }
    case 'person':
      return s.birthYear ? `* ${s.birthYear}` : ''
  }
}
