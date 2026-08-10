// Integration test: hits both the Local API and the running HTTP server.
// Requires the dev server running against the TEST database in a second terminal:
//   docker compose -f docker-compose.dev.yml up -d
//   DATABASE_URI=postgres://archiv:archiv@localhost:5433/archiv_test pnpm dev
// Then run `pnpm test:int` while that server is up.
//
// This is the kiosk safety property (spec §3, §11): a photo reaches the kiosk download OR the
// kiosk image (slideshow <img> source) ONLY if kioskFreigegeben AND published AND
// not-hidden-person AND not-binned — a VALID signature is never enough. Consent is re-checked per
// request via kioskPhotoWhere() ANDed into an overrideAccess:true query, on BOTH endpoints. Every
// "never serves" case below carries a VALID, correctly-signed token of the matching kind — the
// point is that the signature alone must not be sufficient.
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
  const d = signKioskToken({ sid, pid, exp: validExp, kind: 'download' })
  return fetch(`http://localhost:3000/api/kiosk/download?d=${encodeURIComponent(d)}`)
}

async function image(pid: number): Promise<Response> {
  const d = signKioskToken({ sid, pid, exp: validExp, kind: 'image' })
  return fetch(`http://localhost:3000/api/kiosk/image?d=${encodeURIComponent(d)}`)
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
    const d = signKioskToken({ sid: Number(s.id), pid, exp: validExp, kind: 'download' })
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
    const d = signKioskToken({ sid: Number(s.id), pid, exp: validExp, kind: 'download' })
    const res = await fetch(`http://localhost:3000/api/kiosk/download?d=${encodeURIComponent(d)}`)
    expect(res.status).toBe(404)
  })

  it('rejects an expired token (exp claim in the past)', async () => {
    const pid = await makePhoto({ _status: 'published', kioskFreigegeben: true })
    const d = signKioskToken({ sid, pid, exp: Date.now() - 1, kind: 'download' })
    const res = await fetch(`http://localhost:3000/api/kiosk/download?d=${encodeURIComponent(d)}`)
    expect(res.status).toBe(404)
  })

  it('rejects a SESSION-kind token at the download endpoint (kind separation)', async () => {
    const sessionToken = signKioskToken({ sid, exp: validExp })
    const res = await fetch(`http://localhost:3000/api/kiosk/download?d=${encodeURIComponent(sessionToken)}`)
    expect(res.status).toBe(404)
  })

  it('rejects an IMAGE-kind token at the download endpoint (kind separation)', async () => {
    const pid = await makePhoto({ _status: 'published', kioskFreigegeben: true })
    const imageToken = signKioskToken({ sid, pid, exp: validExp, kind: 'image' })
    const res = await fetch(`http://localhost:3000/api/kiosk/download?d=${encodeURIComponent(imageToken)}`)
    expect(res.status).toBe(404)
  })

  it('rejects a garbage/malformed token', async () => {
    const res = await fetch('http://localhost:3000/api/kiosk/download?d=not-a-real-token')
    expect(res.status).toBe(404)
  })
})

// This is the endpoint the slideshow's <img src> actually points at (see task-5 review: Payload's
// own /api/photos/file/:filename, which p.sizes.web.url would resolve to, runs canReadPhoto and
// 403s an anonymous kiosk visitor — every slideshow image would be broken without this route).
// Same safety property as the download endpoint, re-proven against this endpoint specifically:
// a VALID, correctly-signed 'image'-kind token is never enough on its own.
describe('kiosk image endpoint (slideshow <img> source)', () => {
  it('serves a properly marked, published, not-hidden, not-binned photo inline (correct bytes + inline disposition)', async () => {
    const pid = await makePhoto({ _status: 'published', kioskFreigegeben: true })
    expect(await inKioskSet(pid)).toBe(true)
    const res = await image(pid)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toBe('inline')
    expect(res.headers.get('content-type')).toMatch(/^image\//)
    const bytes = Buffer.from(await res.arrayBuffer())
    expect(bytes.length).toBeGreaterThan(0)
  })

  it('never serves an UNMARKED published photo (kioskFreigegeben=false), even with a valid image token', async () => {
    const pid = await makePhoto({ _status: 'published', kioskFreigegeben: false })
    expect((await image(pid)).status).toBe(404)
  })

  it('never serves a HIDDEN-PERSON photo even if marked, even with a valid image token', async () => {
    const person = await payload.create({
      collection: 'people',
      data: { name: 'Verborgen Bild', hidden: true },
      overrideAccess: true,
    })
    const pid = await makePhoto({ _status: 'published', kioskFreigegeben: true, people: [person.id] })
    expect(await inKioskSet(pid)).toBe(false)
    expect((await image(pid)).status).toBe(404)
  })

  it('never serves a DRAFT marked photo, even with a valid image token', async () => {
    const pid = await makePhoto({ _status: 'draft', kioskFreigegeben: true })
    expect((await image(pid)).status).toBe(404)
  })

  it('never serves a BINNED marked photo, even with a valid image token', async () => {
    const pid = await makePhoto({ _status: 'published', kioskFreigegeben: true, deletedAt: new Date().toISOString() })
    expect((await image(pid)).status).toBe(404)
  })

  it('rejects a valid image token once its session is revoked', async () => {
    const pid = await makePhoto({ _status: 'published', kioskFreigegeben: true })
    const s = await payload.create({
      collection: 'kiosk-sessions',
      data: { label: 'rev-img', expiresAt: new Date(validExp).toISOString() },
      overrideAccess: true,
    })
    await payload.update({
      collection: 'kiosk-sessions',
      id: s.id,
      data: { revokedAt: new Date().toISOString() },
      overrideAccess: true,
    })
    const d = signKioskToken({ sid: Number(s.id), pid, exp: validExp, kind: 'image' })
    const res = await fetch(`http://localhost:3000/api/kiosk/image?d=${encodeURIComponent(d)}`)
    expect(res.status).toBe(404)
  })

  it('rejects a valid image token once its session row has expired (independent of the token exp claim)', async () => {
    const pid = await makePhoto({ _status: 'published', kioskFreigegeben: true })
    const s = await payload.create({
      collection: 'kiosk-sessions',
      data: { label: 'expired-img', expiresAt: new Date(Date.now() + 1000).toISOString() },
      overrideAccess: true,
    })
    await payload.update({
      collection: 'kiosk-sessions',
      id: s.id,
      data: { expiresAt: new Date(Date.now() - 1000).toISOString() },
      overrideAccess: true,
    })
    const d = signKioskToken({ sid: Number(s.id), pid, exp: validExp, kind: 'image' })
    const res = await fetch(`http://localhost:3000/api/kiosk/image?d=${encodeURIComponent(d)}`)
    expect(res.status).toBe(404)
  })

  it('rejects a DOWNLOAD-kind token at the image endpoint (kind separation)', async () => {
    const pid = await makePhoto({ _status: 'published', kioskFreigegeben: true })
    const downloadToken = signKioskToken({ sid, pid, exp: validExp, kind: 'download' })
    const res = await fetch(`http://localhost:3000/api/kiosk/image?d=${encodeURIComponent(downloadToken)}`)
    expect(res.status).toBe(404)
  })

  it('rejects a SESSION-kind token at the image endpoint (kind separation)', async () => {
    const sessionToken = signKioskToken({ sid, exp: validExp })
    const res = await fetch(`http://localhost:3000/api/kiosk/image?d=${encodeURIComponent(sessionToken)}`)
    expect(res.status).toBe(404)
  })

  it('rejects a garbage/malformed token', async () => {
    const res = await fetch('http://localhost:3000/api/kiosk/image?d=not-a-real-token')
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

  // Review fix: a non-integer sid (NaN/Infinity/fractional) used to reach payload.update as an
  // `id`, fail inside the DB driver, and rethrow as an unhandled 500 instead of a clean 400.
  it.each([
    ['fractional', 1.5],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['zero', 0],
    ['negative', -1],
  ])('revoking a non-integer sid (%s) returns 400, not a 500', async (_label, sid) => {
    const adminCookie = await loginCookie(adminEmail)
    const res = await fetch('http://localhost:3000/api/kiosk/session', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ sid }),
    })
    expect(res.status).toBe(400)
  })
})

// Review fix: /kiosk-admin's server-component list used to run with Payload's default limit (10)
// and no `pagination:false`, so a busy archive with >10 live sessions would silently hide/strand
// older ones with no UI control to reach them; it also didn't filter out expired-but-unrevoked
// sessions, cluttering the list with dead, unactionable links. This mirrors the exact query
// src/app/(frontend)/kiosk-admin/page.tsx now runs, against the underlying data rather than the
// rendered page (Local API, not a component render).
describe('kiosk-admin session list query (page.tsx query shape)', () => {
  async function listLive(): Promise<{ id: number; label: string | null | undefined }[]> {
    const r = await payload.find({
      collection: 'kiosk-sessions',
      where: { revokedAt: { exists: false }, expiresAt: { greater_than: new Date().toISOString() } },
      sort: '-createdAt',
      depth: 0,
      pagination: false,
      overrideAccess: true,
    })
    return r.docs.map((d) => ({ id: Number(d.id), label: d.label }))
  }

  it('lists a freshly-minted live session', async () => {
    const label = `fresh-${Date.now()}`
    const s = await payload.create({
      collection: 'kiosk-sessions',
      data: { label, expiresAt: new Date(validExp).toISOString() },
      overrideAccess: true,
    })
    const ids = (await listLive()).map((d) => d.id)
    expect(ids).toContain(Number(s.id))
  })

  it('drops a revoked session off the list', async () => {
    const s = await payload.create({
      collection: 'kiosk-sessions',
      data: { label: 'to-revoke', expiresAt: new Date(validExp).toISOString() },
      overrideAccess: true,
    })
    await payload.update({
      collection: 'kiosk-sessions',
      id: s.id,
      data: { revokedAt: new Date().toISOString() },
      overrideAccess: true,
    })
    const ids = (await listLive()).map((d) => d.id)
    expect(ids).not.toContain(Number(s.id))
  })

  it('drops an expired-but-unrevoked session off the list', async () => {
    const s = await payload.create({
      collection: 'kiosk-sessions',
      data: { label: 'expired-unrevoked', expiresAt: new Date(Date.now() - 1000).toISOString() },
      overrideAccess: true,
    })
    const ids = (await listLive()).map((d) => d.id)
    expect(ids).not.toContain(Number(s.id))
  })

  it('shows more than 10 live sessions (pagination:false, no default-limit truncation)', async () => {
    const created = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        payload.create({
          collection: 'kiosk-sessions',
          data: { label: `bulk-${Date.now()}-${i}`, expiresAt: new Date(validExp).toISOString() },
          overrideAccess: true,
        }),
      ),
    )
    const ids = (await listLive()).map((d) => d.id)
    for (const s of created) expect(ids).toContain(Number(s.id))
  })
})
