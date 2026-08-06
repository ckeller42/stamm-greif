// Integration: API error responses carry a Fehler-ID (afterError hook), and the health
// endpoint answers. Needs the dev server running against the TEST database — same setup as
// invites.int.test.ts (see its top-of-file comment).
import { describe, it, expect, beforeAll } from 'vitest'
import { getPayload, type Payload } from 'payload'
import config from '@payload-config'

let payload: Payload
let memberEmail: string
const password = 'geheim123'

beforeAll(async () => {
  payload = await getPayload({ config: await config })
  memberEmail = `tele${Date.now()}@example.com`
  await payload.create({
    collection: 'users',
    data: { name: 'Tele Test', email: memberEmail, password, role: 'mitglied' },
    overrideAccess: true,
  })
})

async function loginCookie(): Promise<string> {
  const res = await fetch('http://localhost:3000/api/users/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: memberEmail, password }),
  })
  expect(res.ok).toBe(true)
  return res.headers.get('set-cookie') ?? ''
}

describe('error responses carry a Fehler-ID', () => {
  it('rejected upload (disallowed mime) returns message with Fehler-ID', async () => {
    const cookie = await loginCookie()
    const body = new FormData()
    // a fake HEIC: content is irrelevant, the mime check fires first — image/heic is not in
    // the Photos mimeTypes allowlist (see Photos.ts), so this is rejected before any decode
    // is attempted. This doubles as the regression test for the HEIC allowlist fix.
    body.append('file', new Blob([new Uint8Array([0, 1, 2, 3])], { type: 'image/heic' }), 'foto.heic')
    body.append('_payload', JSON.stringify({ datePrecision: 'unknown', _status: 'draft' }))
    const res = await fetch('http://localhost:3000/api/photos', {
      method: 'POST', headers: { cookie }, body,
    })
    expect(res.ok).toBe(false)
    const json = (await res.json()) as { errors?: { message: string }[] }
    expect(json.errors?.[0]?.message).toMatch(/Fehler-ID: [0-9a-f]{6}/)
  })
})

describe('health endpoint', () => {
  it('answers 200 ok with error count', async () => {
    const res = await fetch('http://localhost:3000/api/health')
    expect(res.status).toBe(200)
    const json = (await res.json()) as { status: string; db: boolean; errorsLastHour: number }
    expect(json.status).toBe('ok')
    expect(json.db).toBe(true)
    expect(typeof json.errorsLastHour).toBe('number')
  })
})
