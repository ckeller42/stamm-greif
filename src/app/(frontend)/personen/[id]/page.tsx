import { getPayload } from 'payload'
import config from '@payload-config'
import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import { getUser } from '@/lib/get-user'
import { de } from '@/messages/de'
import { formatRange } from '@/lib/time-range'
import { PhotoGrid } from '@/components/PhotoGrid'
import type { Photo } from '@/payload-types'

const membershipRoleLabels: Record<string, string> = {
  mitglied: 'Mitglied', sippenfuehrer: 'Sippenführer', leiter: 'Leiter',
}

export default async function PersonPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getUser()
  if (!user) redirect('/anmelden')
  const { id } = await params
  const payload = await getPayload({ config })

  const person = await payload.findByID({ collection: 'people', id, overrideAccess: false, user }).catch(() => null)
  if (!person) notFound()
  const isKurator = user.role === 'admin' || user.role === 'kurator'
  if (person.hidden && !isKurator) notFound()

  const [memberships, attendance, photos] = await Promise.all([
    payload.find({ collection: 'memberships', where: { person: { equals: id } }, sort: 'vonYear', pagination: false, overrideAccess: false, user }),
    payload.find({ collection: 'attendance', where: { person: { equals: id } }, pagination: false, overrideAccess: false, user }),
    payload.find({ collection: 'photos', where: { people: { contains: id } }, sort: '-dateSortKey', limit: 120, overrideAccess: false, user }),
  ])

  return (
    <>
      <h1>{person.name}</h1>
      {person.bio && <p>{person.bio}</p>}

      <h2>{de.person.gruppen}</h2>
      <ul>
        {memberships.docs.map((m) => {
          const group = typeof m.group === 'object' ? m.group : null
          const range = formatRange({ von: m.vonYear, bis: m.bisYear })
          return (
            <li key={m.id}>
              {group?.name} · {membershipRoleLabels[m.role] ?? m.role}{range && ` · ${range}`}
            </li>
          )
        })}
      </ul>

      <h2>{de.person.ereignisse}</h2>
      <ul>
        {attendance.docs.map((a) => {
          const event = typeof a.event === 'object' ? a.event : null
          return event ? <li key={a.id}><Link href={`/ereignisse/${event.id}`}>{event.name}</Link></li> : null
        })}
      </ul>

      <h2>{de.person.fotos}</h2>
      <PhotoGrid photos={photos.docs as Photo[]} />
    </>
  )
}
