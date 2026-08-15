import path from 'node:path'
import { promises as fs } from 'node:fs'
import sharp from 'sharp'
import type { Payload } from 'payload'

type PhotoLike = {
  id: number | string
  filename?: string | null
  sizes?: { web?: { filename?: string | null } | null } | null
}

// Same resolution as src/jobs/detectFaces.ts and the kiosk image route: Photos has no staticDir
// override, so files live under <cwd>/photos. Prefer the 1600px `web` derivative (plenty for a
// 1200px print image and far cheaper to decode than a 40MP scan); fall back to the original.
// path.basename() strips any separators before the join (defense-in-depth, as the kiosk routes do).
function resolveFile(photo: PhotoLike): string | null {
  const dir = path.resolve(process.cwd(), 'photos')
  const web = photo.sizes?.web?.filename
  if (web) return path.join(dir, path.basename(web))
  if (photo.filename) return path.join(dir, path.basename(photo.filename))
  return null
}

/**
 * A print-bounded JPEG buffer for one photo, or null if the file is missing/undecodable.
 *
 * Transcoding through sharp (already a dep) does three jobs at once: it bakes EXIF orientation,
 * bounds the embedded image to a print-sensible size, and — crucially — GUARANTEES a JPEG, which
 * @react-pdf/renderer's jay-peg decoder reads reliably. @react-pdf/image cannot decode WebP/TIFF
 * and mishandles some PNGs, so feeding it raw derivative bytes would silently drop those photos;
 * always transcoding closes that gap (spec §5, §6.3). A missing/undecodable file is a SOFT skip
 * (logged, that photo omitted) — one bad file must never fail the whole book.
 */
export async function photoToJpegBuffer(photo: PhotoLike, logger?: Payload['logger']): Promise<Buffer | null> {
  const file = resolveFile(photo)
  if (!file) return null
  try {
    const bytes = await fs.readFile(file)
    return await sharp(bytes).rotate().resize({ width: 1200, withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer()
  } catch (err) {
    logger?.info({ msg: 'fotobuch-image-skipped', photoId: photo.id, reason: err instanceof Error ? err.message : String(err) })
    return null
  }
}
