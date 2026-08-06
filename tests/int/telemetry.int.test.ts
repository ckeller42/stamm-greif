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
    // A minimal ISOBMFF ftyp box with a 'heic' major brand — genuinely content-sniffed as
    // image/heic by Payload's file-type detection (checkFileRestrictions), not just declared
    // via the Blob's content-type or filename extension. image/heic is not in the Photos
    // mimeTypes allowlist (see Photos.ts), so detection succeeds but the allowlist check
    // rejects it. This is the regression test for the HEIC allowlist fix: reverting the
    // allowlist change would make this request succeed instead of failing here.
    const ftypHeic = new Uint8Array([
      0x00, 0x00, 0x00, 0x18, // box size 24
      0x66, 0x74, 0x79, 0x70, // 'ftyp'
      0x68, 0x65, 0x69, 0x63, // major brand 'heic'
      0x00, 0x00, 0x00, 0x00, // minor version
      0x68, 0x65, 0x69, 0x63, // compatible brand 'heic'
      0x6d, 0x69, 0x66, 0x31, // compatible brand 'mif1'
    ])
    body.append('file', new Blob([ftypHeic], { type: 'image/heic' }), 'foto.heic')
    body.append('_payload', JSON.stringify({ datePrecision: 'unknown', _status: 'draft' }))
    const res = await fetch('http://localhost:3000/api/photos', {
      method: 'POST', headers: { cookie }, body,
    })
    expect(res.ok).toBe(false)
    const json = (await res.json()) as {
      errors?: { message: string; data?: { errors?: { message: string }[] } }[]
    }
    expect(json.errors?.[0]?.message).toMatch(/Fehler-ID: [0-9a-f]{6}/)
    // Confirms the rejection is the mime-allowlist check (naming image/heic), not a
    // decode/extension-fallback error.
    expect(json.errors?.[0]?.data?.errors?.[0]?.message).toBe('Invalid MIME type: image/heic.')
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
