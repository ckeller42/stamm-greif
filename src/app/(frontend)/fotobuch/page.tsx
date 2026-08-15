import { getPayload } from 'payload'
import config from '@payload-config'
import { notFound, redirect } from 'next/navigation'
import { getUser } from '@/lib/get-user'
import { de } from '@/messages/de'
import { collectFotobuchPhotos, type FotobuchTargetType } from '@/lib/fotobuch-query'
import { FotobuchForm } from './FotobuchForm'

export const dynamic = 'force-dynamic'

// Kurator/admin-gated exclude UX (spec Task 6). notFound() rather than a 403, matching
// /gesichter's and /kiosk-admin's gate. The eligible-photo list below goes exclusively through
// collectFotobuchPhotos — THE consent filter (fotobuch-query.ts) — so a hidden-person or
// draft/binned photo is never even listed for exclusion, let alone excludable-back-in.
export default async function FotobuchPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; id?: string }>
}) {
  const user = await getUser()
  if (!user) redirect('/anmelden')
  if (user.role !== 'admin' && user.role !== 'kurator') notFound()

  const { type, id } = await searchParams
  const parsedId = Number(id)
  const validType = type === 'event' || type === 'series' || type === 'person'
  if (!validType || !Number.isFinite(parsedId)) {
    return (
      <>
        <h1>{de.fotobuch.title}</h1>
        <p>{de.fotobuch.hint}</p>
      </>
    )
  }

  const payload = await getPayload({ config })
  const photos = await collectFotobuchPhotos(payload, { type: type as FotobuchTargetType, id: parsedId })

  return (
    <>
      <h1>{de.fotobuch.title}</h1>
      <p>{de.fotobuch.hint}</p>
      <FotobuchForm
        type={type as FotobuchTargetType}
        id={parsedId}
        photos={photos.map((p) => ({
          id: p.id,
          caption: p.caption ?? null,
          // FotobuchPhoto's narrow select (fotobuch-query.ts) has no top-level `url` field — only
          // `sizes` — so the fallback chain stays within what's actually selected rather than
          // casting to the full `Photo` shape for a field that was deliberately left out.
          thumbUrl: p.sizes?.thumbnail?.url ?? p.sizes?.web?.url ?? null,
        }))}
      />
    </>
  )
}
