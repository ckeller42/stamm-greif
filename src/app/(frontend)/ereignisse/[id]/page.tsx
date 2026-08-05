import { getPayload } from 'payload'
import config from '@payload-config'
import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import { RichText } from '@payloadcms/richtext-lexical/react'
import { getUser } from '@/lib/get-user'
import { de } from '@/messages/de'
import { parseFuzzyDate, type FuzzyPrecision } from '@/lib/fuzzy-date'
import { PhotoGrid } from '@/components/PhotoGrid'
import type { Photo } from '@/payload-types'

export default async function EventPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getUser()
  if (!user) redirect('/anmelden')
  const { id } = await params
  const payload = await getPayload({ config })

  const event = await payload.findByID({ collection: 'events', id, overrideAccess: false, user }).catch(() => null)
  if (!event) notFound()
  const isKurator = user.role === 'admin' || user.role === 'kurator'
  const { label } = parseFuzzyDate({ precision: (event.datePrecision ?? 'unknown') as FuzzyPrecision, value: event.dateValue })
  const place = typeof event.place === 'object' ? event.place : null
  const series = typeof event.series === 'object' ? event.series : null

  const [attendance, photos, siblings] = await Promise.all([
    payload.find({ collection: 'attendance', where: { event: { equals: id } }, pagination: false, overrideAccess: false, user }),
    payload.find({ collection: 'photos', where: { event: { equals: id } }, sort: '-dateSortKey', limit: 200, overrideAccess: false, user }),
    series
      ? payload.find({ collection: 'events', where: { series: { equals: series.id } }, sort: 'dateSortKey', pagination: false, overrideAccess: false, user })
      : Promise.resolve(null),
  ])

  const attendees = attendance.docs
    .map((a) => (typeof a.person === 'object' ? a.person : null))
    .filter((p): p is NonNullable<typeof p> => p != null && (!p.hidden || isKurator))

  return (
    <>
      <h1>{event.name}</h1>
      <p style={{ color: 'var(--muted)' }}>{label}{place && ` · ${place.name}`}</p>
      {event.story && <RichText data={event.story} />}

      <h2>{de.event.teilnehmer}</h2>
      <ul>{attendees.map((p) => <li key={p.id}><Link href={`/personen/${p.id}`}>{p.name}</Link></li>)}</ul>

      <h2>{de.event.fotos}</h2>
      <PhotoGrid photos={photos.docs as Photo[]} />

      {series && siblings && (
        <>
          <h2>{de.event.reihe} „{series.name}“</h2>
          <ul style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', listStyle: 'none', padding: 0 }}>
            {siblings.docs.map((s) => (
              <li key={s.id}>
                {String(s.id) === String(id) ? <strong>{s.name}</strong> : <Link href={`/ereignisse/${s.id}`}>{s.name}</Link>}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  )
}
