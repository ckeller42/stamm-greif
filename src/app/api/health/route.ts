import { getPayload } from 'payload'
import config from '@payload-config'
import { errorsLastHour } from '@/lib/telemetry'
import { facesEnabled } from '@/lib/faces'
import { modelsPresent } from '@/lib/face-model'

// Liveness + degradation signal for Uptime Kuma (see docs/betrieb.md „Monitoring"): 200 = ok,
// 503 = DB unreachable. Static route — takes precedence over Payload's /api/[...slug] catchall.
export const dynamic = 'force-dynamic'

// Module-scope cache: FACE_DETECTION_ENABLED and the model files on disk are both fixed for the
// life of the process (env is read once at boot, models are placed before `pnpm start` runs), so
// re-checking them on every hit — this endpoint is polled by Uptime Kuma on a short interval —
// would just be a repeated fs.existsSync for no benefit. Computed lazily on first request rather
// than at import time so route module evaluation never touches the filesystem.
let facesCache: 'aus' | 'bereit' | 'Modell fehlt' | undefined
function facesStatus(): 'aus' | 'bereit' | 'Modell fehlt' {
  if (facesCache === undefined) {
    facesCache = !facesEnabled() ? 'aus' : modelsPresent() ? 'bereit' : 'Modell fehlt'
  }
  return facesCache
}

export async function GET(): Promise<Response> {
  let db = false
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      (async () => {
        const payload = await getPayload({ config })
        await payload.count({ collection: 'users', overrideAccess: true })
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('db timeout')), 2000)
      }),
    ])
    db = true
  } catch {
    db = false
  } finally {
    if (timer) clearTimeout(timer)
  }
  // Informational ONLY: never influences `status` and never changes the HTTP code. Uptime Kuma
  // must not page the owner because a face model is missing.
  return Response.json(
    { status: db ? 'ok' : 'degraded', db, errorsLastHour: errorsLastHour(), faces: facesStatus() },
    { status: db ? 200 : 503 },
  )
}
