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
      const year = Number(y)
      const month = Number(mo)
      const day = Number(d)
      // Validate calendar correctness via Date round-trip
      const date = new Date(Date.UTC(year, month - 1, day))
      if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
        return { ...UNKNOWN }
      }
      return { sortKey: Number(`${y}${mo}${d}`), label: `${d}.${mo}.${y}` }
    }
    case 'year': {
      if (!/^\d{4}$/.test(v)) return { ...UNKNOWN }
      return { sortKey: Number(v) * 10_000, label: v }
    }
    case 'decade': {
      // A decade must be a 4-digit year ending in 0 (e.g. 1980). Reject values like 1987, which
      // would otherwise produce a nonsensical "1987er Jahre" label.
      if (!/^\d{4}$/.test(v) || Number(v) % 10 !== 0) return { ...UNKNOWN }
      return { sortKey: Number(v) * 10_000, label: `${v}er Jahre` }
    }
    default:
      return { ...UNKNOWN }
  }
}
