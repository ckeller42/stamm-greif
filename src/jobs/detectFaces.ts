// P2.3: detect faces on a published photo and store one face-suggestions row per face, with the
// embedding computed up front. Runs as a job, not inline in the publish request, because
// inference is hundreds of milliseconds of WASM rather than the few milliseconds applyPhash
// costs. Its own `faces` queue keeps a slow face job from starving the daily Papierkorb purge.
import fs from 'node:fs/promises'
import path from 'node:path'
import type { TaskConfig, TaskHandler, PayloadRequest } from 'payload'
import { analyseFaces, modelsPresent } from '@/lib/face-model'
import { boxIoU, facesEnabled, IOU_DUPLICATE_THRESHOLD, normalizeBox, type Box } from '@/lib/faces'

type DetectFacesIO = {
  input: { photoId: string | number }
  output: { suggestionCount: number }
}

type PhotoLike = {
  id: string | number
  filename?: string | null
  _status?: string | null
  deletedAt?: string | null
  hasHiddenPerson?: boolean | null
  sizes?: { web?: { filename?: string | null } | null } | null
}

/**
 * Photos has no `upload.staticDir` override, so Payload uses its default — the collection slug
 * resolved against process.cwd(), i.e. <cwd>/photos (and /app/photos in the container, which is
 * exactly what docker-compose.yml's `uploads` volume mounts; see the comment there).
 *
 * Prefer the 1600px `web` variant: it is plenty for a 640px detector input and much cheaper to
 * decode than a 40-megapixel scan. Payload skips generating a size larger than the source, so
 * fall back to the original when `web` is absent.
 */
function resolveFile(photo: PhotoLike): { file: string; variant: 'web' | 'original' } | null {
  const dir = path.resolve(process.cwd(), 'photos')
  const web = photo.sizes?.web?.filename
  if (web) return { file: path.join(dir, web), variant: 'web' }
  if (photo.filename) return { file: path.join(dir, photo.filename), variant: 'original' }
  return null
}

export const detectFacesHandler: TaskHandler<DetectFacesIO> = async ({ input, req }) => {
  const photo = (await req.payload.findByID({
    collection: 'photos',
    id: input.photoId,
    overrideAccess: true,
    disableErrors: true,
    depth: 0,
    req,
  })) as PhotoLike | null

  // Re-check every guard: the photo may have been unpublished, binned or had a hidden person
  // added between the enqueue and this run.
  if (!photo) return { output: { suggestionCount: 0 } }
  if (!facesEnabled() || !modelsPresent()) return { output: { suggestionCount: 0 } }
  if (photo._status !== 'published' || photo.deletedAt || photo.hasHiddenPerson) {
    return { output: { suggestionCount: 0 } }
  }
  const resolved = resolveFile(photo)
  if (!resolved) return { output: { suggestionCount: 0 } }

  // Same "recheck every guard" reasoning as the _status/deletedAt/hasHiddenPerson checks above,
  // extended to the file itself: between this job being queued and actually running, the file can
  // be gone even though the row survived — a hard delete racing the queue, or (empirically hit
  // while testing this against the full int suite, where the shared `faces` queue is drained both
  // by this job's own autoRun cron AND by other test files publishing/deleting photos
  // concurrently) another photo's cleanup removing a file this job had already resolved a path
  // for. ENOENT here is exactly as unsurprising as "the photo got unpublished mid-flight" — soft
  // no-op, not a retryable TaskError. Letting it escape as an uncaught rejection instead measurably
  // left the pg pool in an aborted-transaction state that broke unrelated later queries in the
  // same process (repro: tests/int/faces.int.test.ts's afterAll cleanup failing with Postgres
  // 25P02 right after a job errored this way) — so this is a correctness fix, not just tidiness.
  // Any OTHER read error (permissions, disk corruption) is not this specific race and still
  // throws, so it still gets Payload's normal TaskError retry/log treatment.
  let buffer: Buffer
  try {
    buffer = await fs.readFile(resolved.file)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      req.payload.logger.info({ msg: 'face-detect-file-missing', photoId: photo.id, file: resolved.file })
      return { output: { suggestionCount: 0 } }
    }
    throw err
  }
  const { width, height, faces } = await analyseFaces(buffer)

  // Idempotency: drop this photo's still-open rows, then skip any new box that lands on a face a
  // kurator already decided about, so a re-run can never resurrect a rejected face.
  await req.payload.delete({
    collection: 'face-suggestions',
    where: { and: [{ photo: { equals: photo.id } }, { status: { equals: 'offen' } }] },
    overrideAccess: true,
    req,
  })
  const decided = await req.payload.find({
    collection: 'face-suggestions',
    where: { and: [{ photo: { equals: photo.id } }, { status: { not_equals: 'offen' } }] },
    limit: 0,
    pagination: false,
    overrideAccess: true,
    depth: 0,
    req,
  })
  const decidedBoxes: Box[] = decided.docs.map((d) => ({
    xMin: d.boxXMin, yMin: d.boxYMin, xMax: d.boxXMax, yMax: d.boxYMax,
  }))

  let suggestionCount = 0
  for (const face of faces) {
    const box = normalizeBox(face.box, width, height)
    if (decidedBoxes.some((b) => boxIoU(b, box) > IOU_DUPLICATE_THRESHOLD)) continue
    await req.payload.create({
      collection: 'face-suggestions',
      data: {
        // photo.id comes through PhotoLike's generic `string | number` (the input contract
        // shared with enqueueDetectFaces below), but this app's only DB adapter (Postgres) uses
        // numeric ids — the FaceSuggestion.photo relationship field's generated type reflects
        // that (`number | Photo`, never `string`).
        photo: photo.id as number,
        boxXMin: box.xMin, boxYMin: box.yMin, boxXMax: box.xMax, boxYMax: box.yMax,
        boxProbability: face.score,
        embedding: face.embedding,
        status: 'offen',
        detectedAt: new Date().toISOString(),
        sourceVariant: resolved.variant,
      },
      overrideAccess: true,
      req,
    })
    suggestionCount++
  }

  req.payload.logger.info({ msg: 'face-detect', photoId: photo.id, detected: faces.length, suggestionCount })
  return { output: { suggestionCount } }
}

export const detectFacesTask: TaskConfig<DetectFacesIO> = {
  slug: 'detectFaces',
  label: 'Gesichter erkennen',
  handler: detectFacesHandler,
  // Two attempts, not three: there is no network in this path, so a second failure is a bug or a
  // missing model — retrying a third time fixes neither.
  retries: { attempts: 2, backoff: { type: 'exponential', delay: 30_000 } },
}

/** Shared by the publish hook and the backfill task so the eligibility rule exists exactly once. */
export async function enqueueDetectFaces(req: PayloadRequest, photoId: string | number): Promise<void> {
  await req.payload.jobs.queue({ task: 'detectFaces', input: { photoId }, queue: 'faces', req })
}
