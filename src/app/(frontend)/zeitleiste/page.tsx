import { getPayload } from 'payload'
import config from '@payload-config'
import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import { getUser } from '@/lib/get-user'
import { de } from '@/messages/de'
import { parseFuzzyDate, type FuzzyPrecision } from '@/lib/fuzzy-date'
import { PhotoGrid } from '@/components/PhotoGrid'
import { YearBand } from './YearBand'
import type { Photo } from '@/payload-types'

// Members-only timeline/series-scrub — the deliberate opposite of the public /kiosk: every read
// here goes through overrideAccess:false with the logged-in user, so canReadPhoto enforces
// consent (hidden-person/draft/binned already filtered out) exactly like every other
// (frontend) page. No kiosk-style overrideAccess:true anywhere in this file.
export default async function ZeitleistePage({
  searchParams,
}: {
  searchParams: Promise<{ serie?: string; e?: string }>
}) {
  const user = await getUser()
  if (!user) redirect('/anmelden')
  const { serie, e } = await searchParams
  const payload = await getPayload({ config })

  if (!serie) {
    const seriesList = await payload.find({
      collection: 'event-series',
      pagination: false,
      overrideAccess: false,
      user,
    })
    return (
      <>
        <h1>{de.zeitleiste.title}</h1>
        <h2>{de.zeitleiste.chooseSeries}</h2>
        {seriesList.docs.length === 0 ? (
          <p>{de.zeitleiste.noSeries}</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {seriesList.docs.map((s) => (
              <li key={s.id}>
                <Link href={`/zeitleiste?serie=${s.id}`}>{s.name}</Link>
              </li>
            ))}
          </ul>
        )}
      </>
    )
  }

  const series = await payload
    .findByID({ collection: 'event-series', id: serie, overrideAccess: false, user })
    .catch(() => null)
  if (!series) notFound()

  const events = await payload.find({
    collection: 'events',
    where: { series: { equals: serie } },
    sort: 'dateSortKey',
    pagination: false,
    overrideAccess: false,
    user,
  })

  const items = events.docs.map((ev) => ({
    eventId: String(ev.id),
    name: ev.name,
    year: parseFuzzyDate({
      precision: (ev.datePrecision ?? 'unknown') as FuzzyPrecision,
      value: ev.dateValue,
    }).label,
  }))

  // ?e= must name an event that actually belongs to this series — otherwise a stale/forged link
  // would silently show another series' event's photos under this series' year band.
  const validIds = new Set(items.map((i) => i.eventId))
  const selectedId = e && validIds.has(e) ? e : items[0]?.eventId
  const selectedEvent = items.find((i) => i.eventId === selectedId)

  const photos = selectedId
    ? await payload.find({
        collection: 'photos',
        where: { event: { equals: selectedId } },
        sort: '-dateSortKey',
        limit: 200,
        overrideAccess: false,
        user,
      })
    : null

  return (
    <>
      <h1>{de.zeitleiste.title}</h1>
      <h2>{series.name}</h2>

      {items.length > 0 && <YearBand items={items} selected={selectedId ?? ''} serie={String(serie)} />}

      {selectedEvent && (
        <p style={{ color: 'var(--muted)' }}>
          {de.zeitleiste.jahr}: {selectedEvent.year} — {selectedEvent.name}
        </p>
      )}

      {!photos || photos.docs.length === 0 ? (
        <p>{de.zeitleiste.emptyYear}</p>
      ) : (
        <PhotoGrid photos={photos.docs as Photo[]} />
      )}
    </>
  )
}
