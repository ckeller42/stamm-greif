// Integration: the fotobuch consent property (spec §3) is the point — a hidden-person photo never
// enters a book even when NOT excluded, a hidden person gets no book, exclude only removes, drafts
// and binned photos are absent, and a valid target yields a real PDF. Needs the dev server running
// against the TEST database (same setup as kiosk.int.test.ts).
import path from 'node:path'
import { describe, it, expect, beforeAll } from 'vitest'
import { getPayload, type Payload } from 'payload'
import config from '@payload-config'
import { collectFotobuchPhotos } from '@/lib/fotobuch-query'

let payload: Payload
let kuratorEmail: string
let memberEmail: string
const password = 'geheim123'
// tests/fixtures/gesicht.jpg (named in the original plan) doesn't exist in this repo — dia.jpg is
// the fixture the sibling kiosk/fotobuch-query int suites already use for a plain, faceless photo.
const fixture = path.resolve(process.cwd(), 'tests/fixtures/dia.jpg')

let eventId: number
let visiblePhotoId: number
let hiddenPersonPhotoId: number
let draftPhotoId: number
let binnedPhotoId: number
let hiddenPersonId: number

async function loginCookie(email: string): Promise<string> {
  const res = await fetch('http://localhost:3000/api/users/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  expect(res.ok).toBe(true)
  return res.headers.get('set-cookie') ?? ''
}

// Payload's generated create() types require an explicit `draft: true` alongside a `_status`
// literal on this drafts-enabled collection unless every required field is present — same `as
// any` idiom the sibling kiosk.int.test.ts / fotobuch-query.int.test.ts use for the same reason.
async function makePhoto(over: Record<string, unknown>): Promise<number> {
  const doc = await payload.create({
    collection: 'photos',
    data: { datePrecision: 'unknown', ...over } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    filePath: fixture,
    overrideAccess: true,
  })
  return Number(doc.id)
}

beforeAll(async () => {
  payload = await getPayload({ config: await config })
  const stamp = Date.now()
  kuratorEmail = `fb-kurator${stamp}@example.com`
  memberEmail = `fb-member${stamp}@example.com`
  await payload.create({ collection: 'users', data: { name: 'FB Kurator', email: kuratorEmail, password, role: 'kurator' }, overrideAccess: true })
  await payload.create({ collection: 'users', data: { name: 'FB Member', email: memberEmail, password, role: 'mitglied' }, overrideAccess: true })

  const hidden = await payload.create({ collection: 'people', data: { name: `Verborgen ${stamp}`, hidden: true }, overrideAccess: true })
  hiddenPersonId = hidden.id
  const event = await payload.create({ collection: 'events', data: { name: `Lager ${stamp}`, datePrecision: 'year', dateValue: '1989' }, overrideAccess: true })
  eventId = event.id

  // A clean published photo of the event.
  visiblePhotoId = await makePhoto({
    caption: 'sichtbar', event: eventId, datePrecision: 'year', dateValue: '1989', _status: 'published',
  })

  // A published photo of the SAME event that also tags the hidden person → hasHiddenPerson recomputes true.
  hiddenPersonPhotoId = await makePhoto({
    caption: 'hat verborgene Person', event: eventId, people: [hiddenPersonId],
    datePrecision: 'year', dateValue: '1989', _status: 'published',
  })

  draftPhotoId = await makePhoto({ caption: 'entwurf', event: eventId, _status: 'draft' })

  binnedPhotoId = await makePhoto({
    caption: 'papierkorb', event: eventId, _status: 'published', deletedAt: new Date().toISOString(),
  })
})

describe('collectFotobuchPhotos consent set (spec §3)', () => {
  it('includes the clean published photo, excludes hidden-person/draft/binned — WITHOUT any excludeIds', async () => {
    const set = await collectFotobuchPhotos(payload, { type: 'event', id: eventId })
    const ids = set.map((p) => p.id)
    expect(ids).toContain(visiblePhotoId)
    expect(ids).not.toContain(hiddenPersonPhotoId) // absent though never excluded — consent, not the exclude list
    expect(ids).not.toContain(draftPhotoId)
    expect(ids).not.toContain(binnedPhotoId)
  })

  it('excludeIds only removes: the clean photo drops out when excluded', async () => {
    const set = await collectFotobuchPhotos(payload, { type: 'event', id: eventId, excludeIds: [visiblePhotoId] })
    expect(set.map((p) => p.id)).not.toContain(visiblePhotoId)
  })

  it('excludeIds cannot re-admit a hidden-person photo (not present even when "un-excluded")', async () => {
    const set = await collectFotobuchPhotos(payload, { type: 'event', id: eventId, excludeIds: [] })
    expect(set.map((p) => p.id)).not.toContain(hiddenPersonPhotoId)
  })
})

describe('POST /api/fotobuch', () => {
  it('rejects a mitglied', async () => {
    const cookie = await loginCookie(memberEmail)
    const res = await fetch('http://localhost:3000/api/fotobuch', {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'event', id: eventId }),
    })
    expect(res.status).toBe(403)
  })

  it('rejects an unauthenticated request', async () => {
    const res = await fetch('http://localhost:3000/api/fotobuch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'event', id: eventId }),
    })
    expect(res.status).toBe(401)
  })

  it('refuses a person book for a hidden person', async () => {
    const cookie = await loginCookie(kuratorEmail)
    const res = await fetch('http://localhost:3000/api/fotobuch', {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'person', id: hiddenPersonId }),
    })
    expect(res.status).toBe(403)
  })

  it('rejects an invalid type (not silently coerced)', async () => {
    const cookie = await loginCookie(kuratorEmail)
    const res = await fetch('http://localhost:3000/api/fotobuch', {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'bogus', id: eventId }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects a missing/non-finite id', async () => {
    const cookie = await loginCookie(kuratorEmail)
    const res = await fetch('http://localhost:3000/api/fotobuch', {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'event' }),
    })
    expect(res.status).toBe(400)
  })

  it('produces a valid PDF for a kurator, with excludeIds only subtracting (hidden-person photo absent regardless)', async () => {
    const cookie = await loginCookie(kuratorEmail)
    const res = await fetch('http://localhost:3000/api/fotobuch', {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' },
      // excludeIds intentionally omits hiddenPersonPhotoId — proving the server, not the client
      // list, is what keeps it out.
      body: JSON.stringify({ type: 'event', id: eventId, excludeIds: [] }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/pdf')
    expect(res.headers.get('content-disposition')).toContain('attachment')
    const buf = Buffer.from(await res.arrayBuffer())
    expect(buf.length).toBeGreaterThan(0)
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })

  it('an admin can also generate a book', async () => {
    const admin = await payload.create({
      collection: 'users',
      data: { name: 'FB Admin', email: `fb-admin${Date.now()}@example.com`, password, role: 'admin' },
      overrideAccess: true,
    })
    const cookie = await loginCookie(admin.email)
    const res = await fetch('http://localhost:3000/api/fotobuch', {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'event', id: eventId }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/pdf')
  })
})
