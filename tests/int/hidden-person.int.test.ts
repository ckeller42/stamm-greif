// Integration test: Local API only (no HTTP server needed for these tests), but
// run via `pnpm test:int` alongside invites.int.test.ts which DOES need the dev
// server running against the TEST database (see top-of-file comment there).

import { describe, it, expect, beforeAll } from 'vitest'
import { getPayload, type Payload } from 'payload'
import config from '@payload-config'
import path from 'path'

let payload: Payload
let mitglied: { id: string | number }

beforeAll(async () => {
  payload = await getPayload({ config: await config })
  mitglied = await payload.create({
    collection: 'users',
    data: { name: 'Mitglied M', email: `m${Date.now()}@example.com`, password: 'geheim123', role: 'mitglied' },
    overrideAccess: true,
  })
})

const fixture = path.resolve(process.cwd(), 'tests/fixtures/dia.jpg')

async function createPublishedPhoto(peopleIds: number[] = []) {
  return payload.create({
    collection: 'photos',
    filePath: fixture,
    data: { caption: 'Test', datePrecision: 'year', dateValue: '1989', people: peopleIds, _status: 'published' },
    overrideAccess: true,
  })
}

async function findAsMitglied() {
  const user = await payload.findByID({ collection: 'users', id: mitglied.id, overrideAccess: true })
  return payload.find({ collection: 'photos', overrideAccess: false, user })
}

describe('photo visibility', () => {
  it('mitglied sees published photo of visible person', async () => {
    const p = await payload.create({ collection: 'people', data: { name: 'Sichtbar' }, overrideAccess: true })
    const photo = await createPublishedPhoto([p.id])
    const res = await findAsMitglied()
    expect(res.docs.map((d) => d.id)).toContain(photo.id)
  })

  it('hiding a person hides their photos from mitglied immediately', async () => {
    const p = await payload.create({ collection: 'people', data: { name: 'Verborgen' }, overrideAccess: true })
    const photo = await createPublishedPhoto([p.id])
    await payload.update({ collection: 'people', id: p.id, data: { hidden: true }, overrideAccess: true })
    const res = await findAsMitglied()
    expect(res.docs.map((d) => d.id)).not.toContain(photo.id)
  })

  it('draft photos are invisible to other mitglieder', async () => {
    const draft = await payload.create({
      collection: 'photos', filePath: fixture,
      data: { caption: 'Entwurf', datePrecision: 'unknown', _status: 'draft' },
      overrideAccess: true,
    })
    const res = await findAsMitglied()
    expect(res.docs.map((d) => d.id)).not.toContain(draft.id)
  })

  it('soft-deleted photos are invisible to mitglied', async () => {
    const photo = await createPublishedPhoto()
    await payload.update({
      collection: 'photos', id: photo.id, data: { deletedAt: new Date().toISOString() }, overrideAccess: true,
    })
    const res = await findAsMitglied()
    expect(res.docs.map((d) => d.id)).not.toContain(photo.id)
  })
})
