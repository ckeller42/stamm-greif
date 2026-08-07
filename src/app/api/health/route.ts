import { getPayload } from 'payload'
import config from '@payload-config'
import { errorsLastHour } from '@/lib/telemetry'

// Liveness + degradation signal for Uptime Kuma (see docs/betrieb.md „Monitoring"): 200 = ok,
// 503 = DB unreachable. Static route — takes precedence over Payload's /api/[...slug] catchall.
export const dynamic = 'force-dynamic'

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
  return Response.json(
    { status: db ? 'ok' : 'degraded', db, errorsLastHour: errorsLastHour() },
    { status: db ? 200 : 503 },
  )
}
