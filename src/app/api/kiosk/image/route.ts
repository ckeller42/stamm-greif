import path from 'path'
import { promises as fs } from 'fs'
import { getPayload } from 'payload'
import config from '@payload-config'
import { verifyKioskToken } from '@/lib/kiosk-token'
import { kioskPhotoWhere } from '@/lib/kiosk-query'
import { loadValidSession } from '@/lib/kiosk-session'

export const dynamic = 'force-dynamic'

// GET /api/kiosk/image?d=<token>. The slideshow's <img src> — no user auth, same authority model
// as /api/kiosk/download (signed token PLUS a live consent re-check), but a DIFFERENT token kind
// ('image' vs 'download') and a DIFFERENT response shape: inline WEB-size derivative bytes for
// display, not an attachment-original download. Payload's own /api/photos/file/:filename route
// (what photo.sizes.web.url resolves to) runs canReadPhoto and 403s an anonymous kiosk visitor —
// this route exists so the beamer can actually show the image at all. Order (mirrors download):
// verify signature+exp → session live? → kioskPhotoWhere() consent → stream web-size bytes,
// falling back to the original if no web derivative exists. The consent re-check is what makes
// revoking consent break an already-rendered slide, not just future downloads.
export async function GET(req: Request): Promise<Response> {
  const token = new URL(req.url).searchParams.get('d') ?? ''
  const payloadTok = verifyKioskToken(token, 'image')
  if (!payloadTok || !('pid' in payloadTok)) return new Response('Not found', { status: 404 })

  const payload = await getPayload({ config })
  const session = await loadValidSession(payload, payloadTok.sid)
  if (!session) return new Response('Not found', { status: 404 })

  // THE consent re-check. overrideAccess:true is safe only because kioskPhotoWhere() reimposes the
  // full consent filter and we AND it with this photo's id — the exact same single-query,
  // no-OR-creep pattern the download route uses.
  const found = await payload.find({
    collection: 'photos',
    where: { and: [{ id: { equals: payloadTok.pid } }, kioskPhotoWhere()] },
    overrideAccess: true,
    limit: 1,
    depth: 0,
  })
  const photo = found.docs[0] as
    | { filename?: string; mimeType?: string; sizes?: { web?: { filename?: string; mimeType?: string } } }
    | undefined
  if (!photo) return new Response('Not found', { status: 404 })

  const dir = path.resolve(process.cwd(), 'photos')
  // Prefer the web-size derivative (what the beamer should actually render); fall back to the
  // original only if no derivative was generated (e.g. image processing failed on upload).
  const rawName = photo.sizes?.web?.filename ?? photo.filename
  const mimeType = photo.sizes?.web?.filename ? (photo.sizes?.web?.mimeType ?? photo.mimeType) : photo.mimeType
  if (!rawName) return new Response('Not found', { status: 404 })
  // Defense-in-depth: `name` today only ever comes from Payload's own upload/resize filenames,
  // never attacker input, but path.basename() strips any path separators before the join
  // regardless — same cheap insurance as the download route.
  const name = path.basename(rawName)
  let bytes: Buffer
  try {
    bytes = await fs.readFile(path.join(dir, name))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      payload.logger.info({ msg: 'kiosk-image-file-missing', photoId: payloadTok.pid, file: name })
      return new Response('Not found', { status: 404 })
    }
    throw err
  }
  return new Response(bytes as unknown as BodyInit, {
    headers: {
      'Content-Type': mimeType ?? 'application/octet-stream',
      'Content-Disposition': 'inline',
      'Cache-Control': 'no-store',
    },
  })
}
