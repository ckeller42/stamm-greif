import { getPayload } from 'payload'
import config from '@payload-config'
import { getUser } from '@/lib/get-user'
import { signKioskToken } from '@/lib/kiosk-token'
import { kioskTtlHours } from '@/lib/kiosk-session'

export const dynamic = 'force-dynamic'

function baseUrl(req: Request): string {
  return process.env.KIOSK_PUBLIC_URL?.trim() || new URL(req.url).origin
}

// POST /api/kiosk/session — mint a link. Kurator/admin only. Body: { label?, hours? }.
export async function POST(req: Request): Promise<Response> {
  const user = await getUser()
  if (!user || (user.role !== 'admin' && user.role !== 'kurator')) {
    return Response.json({ error: 'Nicht berechtigt' }, { status: 403 })
  }
  const body = (await req.json().catch(() => ({}))) as { label?: string; hours?: number }
  const maxH = kioskTtlHours()
  const hours = Math.min(Math.max(Number(body.hours) || maxH, 1), maxH)
  const expiresAt = new Date(Date.now() + hours * 3600_000)
  const payload = await getPayload({ config })
  const session = await payload.create({
    collection: 'kiosk-sessions',
    data: { label: body.label ?? '', expiresAt: expiresAt.toISOString(), createdBy: user.id },
    overrideAccess: true,
  })
  const token = signKioskToken({ sid: Number(session.id), exp: expiresAt.getTime() })
  const url = `${baseUrl(req)}/kiosk?k=${encodeURIComponent(token)}`
  return Response.json({ url, expiresAt: expiresAt.toISOString(), sid: session.id })
}

// DELETE /api/kiosk/session — revoke. Body: { sid }. Kurator/admin only.
export async function DELETE(req: Request): Promise<Response> {
  const user = await getUser()
  if (!user || (user.role !== 'admin' && user.role !== 'kurator')) {
    return Response.json({ error: 'Nicht berechtigt' }, { status: 403 })
  }
  const { sid } = (await req.json().catch(() => ({}))) as { sid?: number }
  if (typeof sid !== 'number') return Response.json({ error: 'sid fehlt' }, { status: 400 })
  const payload = await getPayload({ config })
  try {
    await payload.update({
      collection: 'kiosk-sessions',
      id: sid,
      data: { revokedAt: new Date().toISOString() },
      overrideAccess: true,
    })
  } catch (err) {
    // Revoking a sid that doesn't exist (already deleted, typo, stale admin UI) is a clean 404,
    // not an unhandled 500 — payload.update throws Payload's own NotFound (status 404) for an
    // unknown id under overrideAccess:true; any other error is a real failure and still bubbles.
    if ((err as { status?: number }).status === 404) {
      return Response.json({ error: 'Nicht gefunden' }, { status: 404 })
    }
    throw err
  }
  return Response.json({ ok: true })
}
