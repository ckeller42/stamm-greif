import { headers } from 'next/headers'
import { getPayload } from 'payload'
import config from '@payload-config'
import { verifyKioskToken, signKioskToken } from '@/lib/kiosk-token'
import { kioskPhotoWhere } from '@/lib/kiosk-query'
import { loadValidSession } from '@/lib/kiosk-session'
import { qrSvg } from '@/lib/qr'
import { de } from '@/messages/de'
import { Slideshow } from './Slideshow'
import type { Photo } from '@/payload-types'

export const dynamic = 'force-dynamic'

// The QR must be scannable by an arbitrary phone camera, which has no notion of "this page's
// origin" — a root-relative path only resolves against a base document, which a QR scan doesn't
// have. So the encoded link is always absolute: KIOSK_PUBLIC_URL if the operator configured one
// (same env /api/kiosk/session's mint route reads for the /kiosk?k= link itself), otherwise
// derived from the inbound Host header — the server-component equivalent of that route's
// `new URL(req.url).origin` fallback (a Route Handler's req.url is itself resolved from the same
// Host header). Keeping both routes on the same "env override, else inbound host" rule is the
// "keep both routes consistent" call from the task brief.
async function kioskBaseUrl(): Promise<string> {
  const configured = process.env.KIOSK_PUBLIC_URL?.trim()
  if (configured) return configured.replace(/\/+$/, '')
  const h = await headers()
  const host = h.get('host') ?? 'localhost:3000'
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https')
  return `${proto}://${host}`
}

export default async function KioskPage({
  searchParams,
}: {
  searchParams: Promise<{ k?: string; interval?: string }>
}) {
  const { k = '', interval } = await searchParams
  const tok = verifyKioskToken(k, 'session')
  if (!tok) return <KioskMessage text={de.kiosk.invalid} />

  const payload = await getPayload({ config })
  const session = await loadValidSession(payload, tok.sid)
  if (!session) return <KioskMessage text={de.kiosk.invalid} />

  // overrideAccess:true is REQUIRED (no user) and SAFE only because kioskPhotoWhere() reimposes
  // the full consent filter — this is the one deliberate public overrideAccess in the app.
  const photos = await payload.find({
    collection: 'photos',
    where: kioskPhotoWhere(),
    overrideAccess: true,
    sort: '-dateSortKey',
    limit: 500,
    depth: 0,
  })
  if (photos.totalDocs === 0) return <KioskMessage text={de.kiosk.empty} />

  const base = await kioskBaseUrl()
  const expMs = new Date(session.expiresAt).getTime()
  const slides = (photos.docs as Photo[]).map((p) => {
    const dl = signKioskToken({ sid: session.id, pid: Number(p.id), exp: expMs })
    return {
      id: p.id,
      src: p.sizes?.web?.url ?? p.url ?? '',
      caption: p.caption ?? '',
      qr: qrSvg(`${base}/api/kiosk/download?d=${encodeURIComponent(dl)}`),
    }
  })
  const seconds = Math.min(Math.max(Number(interval) || 8, 3), 60)
  return <Slideshow slides={slides} intervalMs={seconds * 1000} scanHint={de.kiosk.scanHint} />
}

function KioskMessage({ text }: { text: string }) {
  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', color: '#eee', background: '#000' }}>
      <p>{text}</p>
    </div>
  )
}
