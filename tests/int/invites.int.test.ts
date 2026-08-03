// Integration test: hits both the Local API and the running HTTP server.
// Requires the dev server running against the TEST database in a second terminal:
//   docker compose -f docker-compose.dev.yml up -d
//   DATABASE_URI=postgres://archiv:archiv@localhost:5433/archiv_test pnpm dev
// Then run `pnpm test:int` while that server is up.

import { describe, it, expect, beforeAll } from 'vitest'
import { getPayload, type Payload } from 'payload'
import config from '@payload-config'

let payload: Payload
beforeAll(async () => {
  payload = await getPayload({ config: await config })
})

describe('invite accept', () => {
  it('creates a mitglied user from a valid invite and marks it used', async () => {
    const invite = await payload.create({
      // `data` is cast: `token` has a runtime defaultValue (crypto.randomUUID) but
      // Payload's generated types still mark it required for create() input.
      collection: 'invites', data: { role: 'mitglied' } as any, overrideAccess: true,
    })
    const email = `anna${Date.now()}@example.com`
    const res = await fetch('http://localhost:3000/api/invites/accept', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: invite.token, name: 'Anna Test', email, password: 'geheim123' }),
    })
    expect(res.status).toBe(200)
    const users = await payload.find({
      collection: 'users', where: { email: { equals: email } }, overrideAccess: true,
    })
    expect(users.docs[0]?.role).toBe('mitglied')
    const used = await payload.findByID({ collection: 'invites', id: invite.id, overrideAccess: true })
    expect(used.usedBy).toBeTruthy()
  })

  it('rejects an already-used invite with 410', async () => {
    const invite = await payload.create({ collection: 'invites', data: { role: 'mitglied' } as any, overrideAccess: true })
    const body = (email: string) => JSON.stringify({ token: invite.token, name: 'X', email, password: 'geheim123' })
    await fetch('http://localhost:3000/api/invites/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body(`one${Date.now()}@example.com`) })
    const second = await fetch('http://localhost:3000/api/invites/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body(`two${Date.now()}@example.com`) })
    expect(second.status).toBe(410)
  })

  it('rejects an unknown token with 404', async () => {
    const res = await fetch('http://localhost:3000/api/invites/accept', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'gibtsnicht', name: 'X', email: `x${Date.now()}@example.com`, password: 'geheim123' }),
    })
    expect(res.status).toBe(404)
  })
})
