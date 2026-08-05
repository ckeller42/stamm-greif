import type { Photo } from '@/payload-types'
import { parseFuzzyDate, type FuzzyPrecision } from '@/lib/fuzzy-date'

export function PhotoGrid({ photos }: { photos: Photo[] }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '0.5rem' }}>
      {photos.map((p) => {
        const { label } = parseFuzzyDate({
          precision: (p.datePrecision ?? 'unknown') as FuzzyPrecision,
          value: p.dateValue,
        })
        const thumb = p.sizes?.thumbnail?.url ?? p.url
        const full = p.sizes?.web?.url ?? p.url
        return (
          <a key={p.id} href={full ?? '#'} className="card" style={{ overflow: 'hidden' }}>
            {thumb && (
              <img
                src={thumb}
                alt={p.caption ?? ''}
                loading="lazy"
                style={{ width: '100%', aspectRatio: '1', objectFit: 'cover' }}
              />
            )}
            <div style={{ padding: '0.4rem', fontSize: '0.8rem', color: 'var(--muted)' }}>{p.caption ?? label}</div>
          </a>
        )
      })}
    </div>
  )
}
