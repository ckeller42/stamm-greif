import { getPayload } from 'payload'
import config from '@payload-config'
import { notFound, redirect } from 'next/navigation'
import { getUser } from '@/lib/get-user'
import { de } from '@/messages/de'
import { kioskTtlHours } from '@/lib/kiosk-session'
import { KioskAdmin } from './KioskAdmin'

export const dynamic = 'force-dynamic'

export default async function KioskAdminPage() {
  const user = await getUser()
  if (!user) redirect('/anmelden')
  // notFound() rather than a 403, matching /gesichter's gate.
  if (user.role !== 'admin' && user.role !== 'kurator') notFound()

  const payload = await getPayload({ config })
  // KioskSessions.access.read is admin-only (see the collection's own comment: kurators only ever
  // touch this collection through /api/kiosk/session, which runs overrideAccess:true) — a kurator
  // reading with overrideAccess:false would always get an empty list here. The role check above is
  // already this page's authorization boundary (same posture as the mint/revoke endpoint), so the
  // list query bypasses collection access the same way those endpoints do.
  // Only LIVE sessions are actionable from this page (revoke on an already-expired session is a
  // no-op that just clutters the list) — unrevoked AND not yet past expiresAt. pagination:false
  // so a busy archive with >10 live links (Payload's default page size) doesn't hide/strand older
  // ones behind pagination the UI below never offers a control for.
  const sessions = await payload.find({
    collection: 'kiosk-sessions',
    where: { revokedAt: { exists: false }, expiresAt: { greater_than: new Date().toISOString() } },
    sort: '-createdAt',
    depth: 0,
    pagination: false,
    overrideAccess: true,
  })

  return (
    <>
      <h1>{de.kioskAdmin.title}</h1>
      <p>{de.kioskAdmin.hint}</p>
      <KioskAdmin
        defaultHours={kioskTtlHours()}
        sessions={sessions.docs.map((s) => ({
          id: String(s.id),
          label: s.label ?? '',
          expiresAt: s.expiresAt,
        }))}
      />
    </>
  )
}
