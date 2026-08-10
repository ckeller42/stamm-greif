// Integration test: hits both the Local API and the running HTTP server.
// Requires the dev server running against the TEST database in a second terminal:
//   docker compose -f docker-compose.dev.yml up -d
//   DATABASE_URI=postgres://archiv:archiv@localhost:5433/archiv_test pnpm dev
// Then run `pnpm test:int` while that server is up.
//
// This is the kiosk safety property (spec §3, §11): a photo reaches the kiosk download ONLY if
// kioskFreigegeben AND published AND not-hidden-person AND not-binned — a VALID signature is
// never enough. Consent is re-checked per request via kioskPhotoWhere() ANDed into an
// overrideAccess:true query. Every "never serves" case below carries a VALID, correctly-signed
// download token — the point is that the signature alone must not be sufficient.
import path from 'node:path'
import { describe, it, expect, beforeAll } from 'vitest'
import { getPayload, type Payload } from 'payload'
import config from '@payload-config'
import { signKioskToken } from '@/lib/kiosk-token'
import { kioskPhotoWhere } from '@/lib/kiosk-query'

let payload: Payload
let sid: number
const validExp = Date.now() + 3600_000
const fixture = path.resolve(process.cwd(), 'tests/fixtures/dia.jpg')
const password = 'geheim123'
const stamp = Date.now()
const memberEmail = `kiosk-mitglied-${stamp}@example.com`
const kuratorEmail = `kiosk-kurator-${stamp}@example.com`
const adminEmail = `kiosk-admin-${stamp}@example.com`

async function makePhoto(over: Record<string, unknown>): Promise<number> {
  const doc = await payload.create({
    collection: 'photos',
    data: { datePrecision: 'year', dateValue: '1990', ...over } as any,
    filePath: fixture,
    overrideAccess: true,
  })
  return Number(doc.id)
}

async function loginCookie(email: string): Promise<string> {
  const res = await fetch('http://localhost:3000/api/users/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  expect(res.ok).toBe(true)
  return res.headers.get('set-cookie') ?? ''
}

beforeAll(async () => {
  payload = await getPayload({ config: await config })
  const s = await payload.create({
    collection: 'kiosk-sessions',
    data: { label: 'test', expiresAt: new Date(validExp).toISOString() },
    overrideAccess: true,
  })
  sid = Number(s.id)
  await Promise.all([
    payload.create({
      collection: 'users',
      data: { name: 'Kiosk Mitglied', email: memberEmail, password, role: 'mitglied' },
      overrideAccess: true,
    }),
    payload.create({
      collection: 'users',
      data: { name: 'Kiosk Kurator', email: kuratorEmail, password, role: 'kurator' },
      overrideAccess: true,
    }),
    payload.create({
      collection: 'users',
      data: { name: 'Kiosk Admin', email: adminEmail, password, role: 'admin' },
      overrideAccess: true,
    }),
  ])
})

async function inKioskSet(pid: number): Promise<boolean> {
  const r = await payload.find({
    collection: 'photos',
    where: { and: [{ id: { equals: pid } }, kioskPhotoWhere()] },
    overrideAccess: true,
    limit: 1,
    depth: 0,
  })
  return r.totalDocs === 1
}

async function download(pid: number): Promise<Response> {
  const d = signKioskToken({ sid, pid, exp: validExp })
  return fetch(`http://localhost:3000/api/kiosk/download?d=${encodeURIComponent(d)}`)
}

describe('kiosk safety property', () => {
  it('serves a properly marked, published, not-hidden, not-binned photo (correct bytes + attachment)', async () => {
    const pid = await makePhoto({ _status: 'published', kioskFreigegeben: true })
    expect(await inKioskSet(pid)).toBe(true)
    const res = await download(pid)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toMatch(/^attachment;/)
    const bytes = Buffer.from(await res.arrayBuffer())
    expect(bytes.length).toBeGreaterThan(0)
  })

  it('never serves an UNMARKED published photo (kioskFreigegeben=false), even with a valid signature', async () => {
    const pid = await makePhoto({ _status: 'published', kioskFreigegeben: false })
    expect(await inKioskSet(pid)).toBe(false)
    expect((await download(pid)).status).toBe(404)
  })

  it('never serves a HIDDEN-PERSON photo even if marked, even with a valid signature', async () => {
    const person = await payload.create({
      collection: 'people',
      data: { name: 'Verborgen', hidden: true },
      overrideAccess: true,
    })
    const pid = await makePhoto({ _status: 'published', kioskFreigegeben: true, people: [person.id] })
    expect(await inKioskSet(pid)).toBe(false) // hasHiddenPerson recomputed on write
    expect((await download(pid)).status).toBe(404)
  })

  it('never serves a DRAFT marked photo, even with a valid signature', async () => {
    const pid = await makePhoto({ _status: 'draft', kioskFreigegeben: true })
    expect((await download(pid)).status).toBe(404)
  })

  it('never serves a BINNED marked photo, even with a valid signature', async () => {
    const pid = await makePhoto({ _status: 'published', kioskFreigegeben: true, deletedAt: new Date().toISOString() })
    expect((await download(pid)).status).toBe(404)
  })

  it('rejects a valid download token once its session is revoked', async () => {
    const pid = await makePhoto({ _status: 'published', kioskFreigegeben: true })
    const s = await payload.create({
      collection: 'kiosk-sessions',
      data: { label: 'rev', expiresAt: new Date(validExp).toISOString() },
      overrideAccess: true,
    })
    await payload.update({
      collection: 'kiosk-sessions',
      id: s.id,
      data: { revokedAt: new Date().toISOString() },
      overrideAccess: true,
    })
    const d = signKioskToken({ sid: Number(s.id), pid, exp: validExp })
    const res = await fetch(`http://localhost:3000/api/kiosk/download?d=${encodeURIComponent(d)}`)
    expect(res.status).toBe(404)
  })

  it('rejects a valid download token once its session row has expired (independent of the token exp claim)', async () => {
    const pid = await makePhoto({ _status: 'published', kioskFreigegeben: true })
    const s = await payload.create({
      collection: 'kiosk-sessions',
      data: { label: 'expired', expiresAt: new Date(Date.now() + 1000).toISOString() },
      overrideAccess: true,
    })
    await payload.update({
      collection: 'kiosk-sessions',
      id: s.id,
      data: { expiresAt: new Date(Date.now() - 1000).toISOString() },
      overrideAccess: true,
    })
    const d = signKioskToken({ sid: Number(s.id), pid, exp: validExp })
    const res = await fetch(`http://localhost:3000/api/kiosk/download?d=${encodeURIComponent(d)}`)
    expect(res.status).toBe(404)
  })

  it('rejects an expired token (exp claim in the past)', async () => {
    const pid = await makePhoto({ _status: 'published', kioskFreigegeben: true })
    const d = signKioskToken({ sid, pid, exp: Date.now() - 1 })
    const res = await fetch(`http://localhost:3000/api/kiosk/download?d=${encodeURIComponent(d)}`)
    expect(res.status).toBe(404)
  })

  it('rejects a SESSION-kind token at the download endpoint (kind separation)', async () => {
    const sessionToken = signKioskToken({ sid, exp: validExp })
    const res = await fetch(`http://localhost:3000/api/kiosk/download?d=${encodeURIComponent(sessionToken)}`)
    expect(res.status).toBe(404)
  })

  it('rejects a garbage/malformed token', async () => {
    const res = await fetch('http://localhost:3000/api/kiosk/download?d=not-a-real-token')
    expect(res.status).toBe(404)
  })
})

describe('mint/revoke session endpoints — admin-only', () => {
  it('anonymous is denied on POST (mint)', async () => {
    const res = await fetch('http://localhost:3000/api/kiosk/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(403)
  })

  it('a mitglied is denied on POST (mint)', async () => {
    const cookie = await loginCookie(memberEmail)
    const res = await fetch('http://localhost:3000/api/kiosk/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(403)
  })

  it('a kurator can mint a link; an admin can mint and revoke it', async () => {
    const kuratorCookie = await loginCookie(kuratorEmail)
    const mintRes = await fetch('http://localhost:3000/api/kiosk/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: kuratorCookie },
      body: JSON.stringify({ label: 'kurator-mint' }),
    })
    expect(mintRes.status).toBe(200)
    const minted = (await mintRes.json()) as { url: string; sid: number; expiresAt: string }
    expect(minted.url).toContain('/kiosk?k=')
    expect(minted.sid).toBeTypeOf('number')

    const adminCookie = await loginCookie(adminEmail)
    const revokeRes = await fetch('http://localhost:3000/api/kiosk/session', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ sid: minted.sid }),
    })
    expect(revokeRes.status).toBe(200)
    const row = await payload.findByID({ collection: 'kiosk-sessions', id: minted.sid, overrideAccess: true })
    expect(row.revokedAt).toBeTruthy()
  })

  it('anonymous is denied on DELETE (revoke)', async () => {
    const s = await payload.create({
      collection: 'kiosk-sessions',
      data: { label: 'del-anon', expiresAt: new Date(validExp).toISOString() },
      overrideAccess: true,
    })
    const res = await fetch('http://localhost:3000/api/kiosk/session', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sid: s.id }),
    })
    expect(res.status).toBe(403)
  })

  it('a mitglied is denied on DELETE (revoke)', async () => {
    const s = await payload.create({
      collection: 'kiosk-sessions',
      data: { label: 'del-mitglied', expiresAt: new Date(validExp).toISOString() },
      overrideAccess: true,
    })
    const cookie = await loginCookie(memberEmail)
    const res = await fetch('http://localhost:3000/api/kiosk/session', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ sid: s.id }),
    })
    expect(res.status).toBe(403)
  })

  it('revoking a non-existent sid returns a clean 404, not a 500', async () => {
    const adminCookie = await loginCookie(adminEmail)
    const res = await fetch('http://localhost:3000/api/kiosk/session', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ sid: 999_999_999 }),
    })
    expect(res.status).toBe(404)
  })
})
