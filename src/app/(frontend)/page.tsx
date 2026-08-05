import { getPayload } from 'payload'
import config from '@payload-config'
import { redirect } from 'next/navigation'
import { getUser } from '@/lib/get-user'
import { de } from '@/messages/de'
import { PhotoGrid } from '@/components/PhotoGrid'
import { FilterBar } from '@/components/FilterBar'
import type { Where } from 'payload'

// Next resolves a repeated query param (?tag=1&tag=2) to a string array. Preserve that shape
// when rebuilding pagination links so multi-values aren't flattened to "1,2", but collapse to a
// single string for the single-select filters below.
type SearchParams = Record<string, string | string[] | undefined>

function buildQuery(params: SearchParams, overrides: Record<string, string>): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((x) => sp.append(k, x))
    else if (v != null) sp.set(k, v)
  }
  for (const [k, v] of Object.entries(overrides)) sp.set(k, v)
  return sp.toString()
}

export default async function ArchivPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const user = await getUser()
  if (!user) redirect('/anmelden')
  const params = await searchParams
  const single: Record<string, string> = Object.fromEntries(
    Object.entries(params).map(([k, v]) => [k, Array.isArray(v) ? (v[0] ?? '') : (v ?? '')]),
  )
  const payload = await getPayload({ config })

  const and: Where[] = []
  // Only a well-formed 4-digit year builds a date filter; otherwise Number('abc') would yield
  // NaN bounds that Payload forwards to the DB, erroring or silently emptying the archive.
  if (/^\d{4}$/.test(single.jahr ?? '')) {
    const jahr = Number(single.jahr)
    and.push({
      dateSortKey: {
        greater_than_equal: jahr * 10_000,
        less_than: (jahr + 1) * 10_000,
      },
    })
  }
  if (single.ereignis) and.push({ event: { equals: single.ereignis } })
  if (single.ort) and.push({ place: { equals: single.ort } })
  if (single.person) and.push({ people: { contains: single.person } })
  if (single.tag) and.push({ tags: { contains: single.tag } })
  if (single.gruppe) {
    // photos of people who were members of the group (time filter refined later)
    const members = await payload.find({
      collection: 'memberships',
      where: { group: { equals: single.gruppe } },
      pagination: false,
      depth: 0,
      overrideAccess: true,
    })
    const personIds = members.docs.map((m) => (typeof m.person === 'object' ? m.person.id : m.person))
    and.push({ people: { in: personIds.length ? personIds : ['0'] } })
  }

  // Only a positive safe integer is a valid page; 2.5, Infinity, NaN, 0 and negatives fall
  // back to 1 rather than reaching payload.find as a bad offset.
  const seiteNum = Number(single.seite)
  const page = Number.isSafeInteger(seiteNum) && seiteNum > 0 ? seiteNum : 1
  const photos = await payload.find({
    collection: 'photos',
    where: and.length ? { and } : {},
    sort: '-dateSortKey',
    limit: 60,
    page,
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
        current={single}
      />
      {photos.docs.length === 0 ? <p>{de.archiv.empty}</p> : <PhotoGrid photos={photos.docs} />}
      {photos.totalPages > 1 && (
        <nav style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
          {Array.from({ length: photos.totalPages }, (_, i) => (
            <a key={i} href={`/?${buildQuery(params, { seite: String(i + 1) })}`}>
              {i + 1}
            </a>
          ))}
        </nav>
      )}
    </>
  )
}
