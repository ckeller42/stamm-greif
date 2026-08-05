import type { Field, FieldHook } from 'payload'
import { parseFuzzyDate, type FuzzyPrecision } from '@/lib/fuzzy-date'

export const setDateSortKey: FieldHook = ({ data }) => {
  const { sortKey } = parseFuzzyDate({
    precision: (data?.datePrecision ?? 'unknown') as FuzzyPrecision,
    value: data?.dateValue,
  })
  return sortKey
}

export const fuzzyDateFields = (): Field[] => [
  {
    name: 'datePrecision', type: 'select', required: true, defaultValue: 'unknown',
    label: 'Datumsgenauigkeit',
    options: [
      { label: 'Genaues Datum', value: 'exact' },
      { label: 'Jahr', value: 'year' },
      { label: 'Jahrzehnt', value: 'decade' },
      { label: 'Unbekannt', value: 'unknown' },
    ],
  },
  {
    name: 'dateValue', type: 'text', label: 'Datum',
    admin: { description: 'JJJJ-MM-TT, JJJJ oder Jahrzehnt (z. B. 1980)' },
  },
  { name: 'dateSortKey', type: 'number', admin: { hidden: true }, hooks: { beforeChange: [setDateSortKey] } },
]
