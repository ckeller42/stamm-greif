'use client'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect } from 'react'
import { de } from '@/messages/de'

type Item = { eventId: string; year: string; name: string }

// Pure navigation aid over server-rendered /zeitleiste?serie=&e= URLs — no local selection
// state, no data fetching. Every step (click or arrow key) pushes a new URL and the server
// component re-renders with that event's consent-filtered photos, so the page stays shareable
// and works with JS disabled (chips are plain <Link>s) — arrows are progressive enhancement.
export function YearBand({ items, selected, serie }: { items: Item[]; selected: string; serie: string }) {
  const router = useRouter()

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      const idx = items.findIndex((i) => i.eventId === selected)
      if (idx === -1) return
      const target = items[idx + (e.key === 'ArrowRight' ? 1 : -1)]
      if (!target) return
      e.preventDefault()
      router.push(`/zeitleiste?serie=${serie}&e=${target.eventId}`)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [items, selected, serie, router])

  return (
    <nav
      aria-label={de.zeitleiste.title}
      style={{ display: 'flex', gap: '0.5rem', overflowX: 'auto', padding: '0.75rem 0', margin: '0.5rem 0' }}
    >
      {items.map((item) => {
        const isSelected = item.eventId === selected
        return (
          <Link
            key={item.eventId}
            href={`/zeitleiste?serie=${serie}&e=${item.eventId}`}
            className="card"
            title={item.name}
            aria-current={isSelected ? 'true' : undefined}
            style={{
              flex: '0 0 auto',
              padding: '0.5rem 0.75rem',
              textDecoration: 'none',
              whiteSpace: 'nowrap',
              color: isSelected ? 'var(--bg)' : 'var(--ink)',
              background: isSelected ? 'var(--gold)' : 'var(--surface)',
            }}
          >
            {item.year}
          </Link>
        )
      })}
    </nav>
  )
}
