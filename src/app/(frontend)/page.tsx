import { getPayload } from 'payload'
import config from '@payload-config'
import { redirect } from 'next/navigation'
import { getUser } from '@/lib/get-user'
import { de } from '@/messages/de'
import { PhotoGrid } from '@/components/PhotoGrid'
import { FilterBar } from '@/components/FilterBar'
import type { Where } from 'payload'

export default async function ArchivPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>
}) {
  const user = await getUser()
  if (!user) redirect('/anmelden')
  const params = await searchParams
  const payload = await getPayload({ config })

  const and: Where[] = []
  if (params.jahr) {
    and.push({
      dateSortKey: {
        greater_than_equal: Number(params.jahr) * 10_000,
        less_than: (Number(params.jahr) + 1) * 10_000,
      },
    })
  }
  if (params.ereignis) and.push({ event: { equals: params.ereignis } })
  if (params.ort) and.push({ place: { equals: params.ort } })
  if (params.person) and.push({ people: { contains: params.person } })
  if (params.tag) and.push({ tags: { contains: params.tag } })
  if (params.gruppe) {
    // photos of people who were members of the group (time filter refined later)
    const members = await payload.find({
      collection: 'memberships',
      where: { group: { equals: params.gruppe } },
      pagination: false,
      depth: 0,
      overrideAccess: true,
    })
    const personIds = members.docs.map((m) => (typeof m.person === 'object' ? m.person.id : m.person))
    and.push({ people: { in: personIds.length ? personIds : ['0'] } })
  }

  const photos = await payload.find({
    collection: 'photos',
    where: and.length ? { and } : {},
    sort: '-dateSortKey',
    limit: 60,
    page: Number(params.seite) || 1,
    overrideAccess: false,
    user,
  })

  const [groups, events, places, people, tags] = await Promise.all([
    payload.find({ collection: 'groups', pagination: false, sort: 'name', overrideAccess: false, user }),
    payload.find({ collection: 'events', pagination: false, sort: 'name', overrideAccess: false, user }),
    payload.find({ collection: 'places', pagination: false, sort: 'name', overrideAccess: false, user }),
    payload.find({ collection: 'people', pagination: false, sort: 'name', overrideAccess: false, user }),
    payload.find({ collection: 'tags', pagination: false, sort: 'name', overrideAccess: false, user }),
  ])

  return (
    <>
      <h1>{de.archiv.title}</h1>
      <FilterBar
        groups={groups.docs}
        events={events.docs}
        places={places.docs}
        people={people.docs}
        tags={tags.docs}
        current={params}
      />
      {photos.docs.length === 0 ? <p>{de.archiv.empty}</p> : <PhotoGrid photos={photos.docs} />}
      {photos.totalPages > 1 && (
        <nav style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
          {Array.from({ length: photos.totalPages }, (_, i) => (
            <a key={i} href={`/?${new URLSearchParams({ ...params, seite: String(i + 1) })}`}>
              {i + 1}
            </a>
          ))}
        </nav>
      )}
    </>
  )
}
