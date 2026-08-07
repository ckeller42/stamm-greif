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

// HEIC/HEIF upload tests (genuine decode, orientation, corrupt-file handling) live in
// tests/int/heic.int.test.ts — capability-gated there since sharp's own prebuilt (what `pnpm
// dev` on a CI runner uses) never advertises HEIC decode support. This file keeps the
// mime-allowlist-rejection regression coverage (below, now using GIF) plus the unrelated
// Fehler-ID/health-endpoint concerns its name refers to.
describe('error responses carry a Fehler-ID', () => {
  it('rejected upload (disallowed mime) returns message with Fehler-ID', async () => {
    const cookie = await loginCookie()
    const body = new FormData()
    // Real GIF magic bytes (GIF89a header) so this is genuinely content-sniffed as image/gif
    // by Payload's file-type detection (checkFileRestrictions), not just declared via the
    // Blob's content-type or filename extension. image/gif is not in the Photos mimeTypes
    // allowlist (see Photos.ts), so detection succeeds but the allowlist check rejects it —
    // this keeps the Fehler-ID/mime-rejection path covered now that HEIC itself is allowed.
    const gif89a = new Uint8Array([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // 'GIF89a'
      0x01, 0x00, 0x01, 0x00, // 1x1 logical screen descriptor
      0x00, 0x00, 0x00, // packed fields, background color, aspect ratio
    ])
    body.append('file', new Blob([gif89a], { type: 'image/gif' }), 'foto.gif')
    body.append('_payload', JSON.stringify({ datePrecision: 'unknown', _status: 'draft' }))
    const res = await fetch('http://localhost:3000/api/photos', {
      method: 'POST', headers: { cookie }, body,
    })
    expect(res.ok).toBe(false)
    const json = (await res.json()) as {
      errors?: { message: string; data?: { errors?: { message: string }[] } }[]
    }
    expect(json.errors?.[0]?.message).toMatch(/Fehler-ID: [0-9a-f]{6}/)
    // Confirms the rejection is the mime-allowlist check (naming image/gif), not a
    // decode/extension-fallback error.
    expect(json.errors?.[0]?.data?.errors?.[0]?.message).toBe('Invalid MIME type: image/gif.')
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
