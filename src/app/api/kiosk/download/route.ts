import path from 'path'
import { promises as fs } from 'fs'
import { getPayload } from 'payload'
import config from '@payload-config'
import { verifyKioskToken } from '@/lib/kiosk-token'
import { kioskPhotoWhere } from '@/lib/kiosk-query'
import { loadValidSession } from '@/lib/kiosk-session'

export const dynamic = 'force-dynamic'

// GET /api/kiosk/download?d=<token>. No user auth — authority is the signed token PLUS a live
// consent re-check. Order (spec §4.5): verify signature+exp → session live? → kioskPhotoWhere()
// consent → stream original bytes. The consent re-check is what makes revoking consent kill an
// in-flight QR link: a photo hidden/binned/unmarked since the QR was rendered yields nothing here.
export async function GET(req: Request): Promise<Response> {
  const token = new URL(req.url).searchParams.get('d') ?? ''
  const payloadTok = verifyKioskToken(token, 'download')
  if (!payloadTok || !('pid' in payloadTok)) return new Response('Not found', { status: 404 })

  const payload = await getPayload({ config })
  const session = await loadValidSession(payload, payloadTok.sid)
  if (!session) return new Response('Not found', { status: 404 })

  // THE consent re-check. overrideAccess:true is safe only because kioskPhotoWhere() reimposes the
  // full consent filter and we AND it with this photo's id.
  const found = await payload.find({
    collection: 'photos',
    where: { and: [{ id: { equals: payloadTok.pid } }, kioskPhotoWhere()] },
    overrideAccess: true,
    limit: 1,
    depth: 0,
  })
  const photo = found.docs[0] as
    | { filename?: string; mimeType?: string; sizes?: { web?: { filename?: string } } }
    | undefined
  if (!photo) return new Response('Not found', { status: 404 })

  const dir = path.resolve(process.cwd(), 'photos')
  const rawName = photo.filename ?? photo.sizes?.web?.filename
  if (!rawName) return new Response('Not found', { status: 404 })
  // Defense-in-depth: `name` today only ever comes from Payload's own upload filename, never
  // attacker input, but path.basename() strips any path separators before the join regardless —
  // cheap insurance against a future code path that lets filename be influenced upstream.
  const name = path.basename(rawName)
  let bytes: Buffer
  try {
    bytes = await fs.readFile(path.join(dir, name))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      payload.logger.info({ msg: 'kiosk-download-file-missing', photoId: payloadTok.pid, file: name })
      return new Response('Not found', { status: 404 })
    }
    throw err
  }
  return new Response(bytes as unknown as BodyInit, {
    headers: {
      'Content-Type': photo.mimeType ?? 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${name.replace(/[^\w.\-]/g, '_')}"`,
      'Cache-Control': 'no-store',
    },
  })
}
