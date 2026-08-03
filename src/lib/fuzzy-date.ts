export type FuzzyPrecision = 'exact' | 'year' | 'decade' | 'unknown'
export interface FuzzyDate { precision: FuzzyPrecision; value?: string | null }

const UNKNOWN = { sortKey: null, label: 'Datum unbekannt' } as const

export function parseFuzzyDate(fd: FuzzyDate): { sortKey: number | null; label: string } {
  const v = fd.value ?? ''
  switch (fd.precision) {
    case 'exact': {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v)
      if (!m) return { ...UNKNOWN }
      const [, y, mo, d] = m
      return { sortKey: Number(`${y}${mo}${d}`), label: `${d}.${mo}.${y}` }
    }
    case 'year': {
      if (!/^\d{4}$/.test(v)) return { ...UNKNOWN }
      return { sortKey: Number(v) * 10_000, label: v }
    }
    case 'decade': {
      if (!/^\d{4}$/.test(v)) return { ...UNKNOWN }
      return { sortKey: Number(v) * 10_000, label: `${v}er Jahre` }
    }
    default:
      return { ...UNKNOWN }
  }
}
