export interface YearRange { von?: number | null; bis?: number | null }

export function activeInYear(r: YearRange, year: number): boolean {
  return (r.von == null || year >= r.von) && (r.bis == null || year <= r.bis)
}

export function overlaps(a: YearRange, b: YearRange): boolean {
  const aStart = a.von ?? -Infinity, aEnd = a.bis ?? Infinity
  const bStart = b.von ?? -Infinity, bEnd = b.bis ?? Infinity
  return aStart <= bEnd && bStart <= aEnd
}

export function formatRange(r: YearRange): string {
  if (r.von != null && r.bis != null) return `${r.von}–${r.bis}`
  if (r.von != null) return `seit ${r.von}`
  if (r.bis != null) return `bis ${r.bis}`
  return ''
}
