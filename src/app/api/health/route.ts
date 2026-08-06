import { getPayload } from 'payload'
import config from '@payload-config'
import { errorsLastHour } from '@/lib/telemetry'

// Liveness + degradation signal for Uptime Kuma (see docs/betrieb.md „Monitoring"): 200 = ok,
// 503 = DB unreachable. Static route — takes precedence over Payload's /api/[...slug] catchall.
export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  let db = false
  try {
    const payload = await getPayload({ config })
    await Promise.race([
      payload.count({ collection: 'users', overrideAccess: true }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('db timeout')), 2000)),
    ])
    db = true
  } catch {
    db = false
  }
  return Response.json(
    { status: db ? 'ok' : 'degraded', db, errorsLastHour: errorsLastHour() },
    { status: db ? 200 : 503 },
  )
}
