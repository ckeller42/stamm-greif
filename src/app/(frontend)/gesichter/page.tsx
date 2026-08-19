import { getPayload } from 'payload'
import config from '@payload-config'
import { notFound, redirect } from 'next/navigation'
import { getUser } from '@/lib/get-user'
import { de } from '@/messages/de'
import { facesEnabled } from '@/lib/faces'
import { FaceReviewForm } from './FaceReviewForm'

export const dynamic = 'force-dynamic'

export default async function GesichterPage() {
  const user = await getUser()
  if (!user) redirect('/anmelden')
  // notFound() rather than a 403, matching how personen/[id] hides a hidden person from members.
  if (user.role !== 'admin' && user.role !== 'kurator') notFound()

  if (!facesEnabled()) {
    return (
      <>
        <h1>{de.gesichter.title}</h1>
        <p>{de.gesichter.disabled}</p>
      </>
    )
  }

  const payload = await getPayload({ config })
  const [suggestions, confirmed, people] = await Promise.all([
    payload.find({
      collection: 'face-suggestions',
      where: { status: { equals: 'offen' } },
      sort: '-detectedAt',
      limit: 30,
      depth: 1,
      overrideAccess: false,
      user,
    }),
    // Final review, M1: the only surface `de.gesichter.undo` ("Rückgängig") is reachable from —
    // spec §7's documented correction path for a wrong confirmation — needs the confirmed rows
    // rendered somewhere. Sorted by confirmedAt (not detectedAt): newest DECISION first, since
    // that's what a kurator scanning this list for "did I just misclick" cares about.
    payload.find({
      collection: 'face-suggestions',
      where: { status: { equals: 'bestaetigt' } },
      sort: '-confirmedAt',
      limit: 30,
      depth: 1,
      overrideAccess: false,
      user,
    }),
    payload.find({
      collection: 'people',
      where: { hidden: { not_equals: true } },
      sort: 'name',
      pagination: false,
      overrideAccess: false,
      user,
    }),
  ])

  // Suggestions whose photo is in the Papierkorb are not reviewable: the bin is reversible, so
  // the rows stay put and simply drop out of the queue until the photo is restored or purged.
  // C3 (consent audit): also drop any suggestion whose photo now has a hidden person. The purge
  // hook and detectFaces' post-write re-check normally delete those rows, but this is the last belt
  // — a row that slipped through a race must still never surface a hidden person's face for review.
  const reviewable = (s: { photo: unknown }) => {
    const photo = s.photo
    return typeof photo === 'object' && photo !== null && !(photo as { deletedAt?: unknown }).deletedAt && !(photo as { hasHiddenPerson?: unknown }).hasHiddenPerson
  }
  const open = suggestions.docs.filter(reviewable)
  const confirmedRows = confirmed.docs.filter(reviewable)

  // Crop by CSS from the existing thumbnail — no face crops are ever written to disk. The 96px
  // viewport shows the box; the image is scaled so the box fills it and shifted so the box's
  // top-left lands at the viewport's origin. Shared by both the offen and bestätigt lists below.
  const VIEW = 96
  function Thumb({ s }: { s: { boxXMin: number; boxYMin: number; boxXMax: number; boxYMax: number; photo: unknown } }) {
    const photo = s.photo as { sizes?: { thumbnail?: { url?: string | null } | null } | null }
    const thumb = photo.sizes?.thumbnail
    const boxW = Math.max(s.boxXMax - s.boxXMin, 0.01)
    const boxH = Math.max(s.boxYMax - s.boxYMin, 0.01)
    const scaledW = VIEW / boxW
    const scaledH = VIEW / boxH
    return (
      <div style={{ width: VIEW, height: VIEW, overflow: 'hidden', position: 'relative', flex: '0 0 auto', background: '#222' }}>
        {thumb?.url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumb.url}
            alt=""
            style={{
              position: 'absolute',
              width: scaledW,
              height: scaledH,
              left: -s.boxXMin * scaledW,
              top: -s.boxYMin * scaledH,
              maxWidth: 'none',
            }}
          />
        )}
      </div>
    )
  }

  return (
    <>
      <h1>{de.gesichter.title}</h1>
      <p>{de.gesichter.hint}</p>
      <p style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>{de.gesichter.irreversibleNotice}</p>
      {open.length === 0 && <p>{de.gesichter.empty}</p>}
      <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: '1rem' }}>
        {open.map((s) => {
          const photo = s.photo as { id: string | number; caption?: string | null; sizes?: { thumbnail?: { url?: string | null; width?: number | null } | null } | null }
          return (
            <li key={s.id} style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
              <Thumb s={s} />
              <div style={{ flex: 1 }}>
                <div>{photo.caption ?? ''}</div>
                {typeof s.similarity === 'number' && (
                  <div style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>
                    {de.gesichter.similarity}: {(s.similarity * 100).toFixed(0)} %
                  </div>
                )}
                <FaceReviewForm
                  suggestionId={String(s.id)}
                  defaultPersonId={s.suggestedPerson ? String(typeof s.suggestedPerson === 'object' ? s.suggestedPerson.id : s.suggestedPerson) : ''}
                  people={people.docs.map((p) => ({ id: String(p.id), name: p.name }))}
                />
              </div>
            </li>
          )
        })}
      </ul>

      <h2>{de.gesichter.confirmedTitle}</h2>
      {confirmedRows.length === 0 && <p>{de.gesichter.confirmedEmpty}</p>}
      <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: '1rem' }}>
        {confirmedRows.map((s) => {
          const photo = s.photo as { id: string | number; caption?: string | null; sizes?: { thumbnail?: { url?: string | null; width?: number | null } | null } | null }
          const person = typeof s.suggestedPerson === 'object' ? s.suggestedPerson : null
          return (
            <li key={s.id} style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
              <Thumb s={s} />
              <div style={{ flex: 1 }}>
                <div>{photo.caption ?? ''}</div>
                <div style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>
                  {de.gesichter.confirmedAs}: {person?.name ?? ''}
                </div>
                <FaceReviewForm
                  suggestionId={String(s.id)}
                  defaultPersonId={person ? String(person.id) : ''}
                  people={[]}
                  mode="bestaetigt"
                />
              </div>
            </li>
          )
        })}
      </ul>
    </>
  )
}
