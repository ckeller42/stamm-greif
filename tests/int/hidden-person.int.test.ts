// Integration test: Local API only for these tests, but run via `pnpm test:int` alongside
// invites.int.test.ts which DOES need the dev server running against the TEST database (see
// top-of-file comment there).
//
// Negative assertions use findByID with disableErrors (or a where-scoped find on the exact id)
// rather than list-page containment checks — the test DB accumulates rows across runs, and a
// default-limit-10 list `find` can push a target doc off page 1, making containment checks
// unreliable.

import { describe, it, expect, beforeAll } from 'vitest'
import { getPayload, type Payload } from 'payload'
import config from '@payload-config'
import path from 'path'

let payload: Payload
let mitgliedA: { id: number }
let mitgliedB: { id: number }
let kurator: { id: number }

beforeAll(async () => {
  payload = await getPayload({ config: await config })
  mitgliedA = await payload.create({
    collection: 'users',
    data: { name: 'Mitglied A', email: `a${Date.now()}@example.com`, password: 'geheim123', role: 'mitglied' },
    overrideAccess: true,
  })
  mitgliedB = await payload.create({
    collection: 'users',
    data: { name: 'Mitglied B', email: `b${Date.now()}@example.com`, password: 'geheim123', role: 'mitglied' },
    overrideAccess: true,
  })
  kurator = await payload.create({
    collection: 'users',
    data: { name: 'Kurator K', email: `k${Date.now()}@example.com`, password: 'geheim123', role: 'kurator' },
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

// Creates a photo as an authenticated (non-overrideAccess) user, so `uploader` is set by the
// collection's beforeChange hook exactly the way a real upload would set it.
async function createPhotoAs(
  user: { id: number },
  overrides: { _status?: 'draft' | 'published'; people?: number[] } = {},
) {
  return payload.create({
    collection: 'photos',
    filePath: fixture,
    data: {
      caption: 'Eigener Upload',
      datePrecision: 'unknown',
      _status: overrides._status ?? 'draft',
      people: overrides.people ?? [],
    },
    user,
    overrideAccess: false,
  })
}

async function findByIdAs(user: { id: number } | null, id: number | string) {
  return payload.findByID({
    collection: 'photos',
    id,
    overrideAccess: false,
    user: user ?? undefined,
    disableErrors: true,
  })
}

async function countScopedAs(user: { id: number } | null, id: number | string) {
  // disableErrors: an anonymous request's access resolves to boolean `false` (rather than a
  // Where clause), which `find` treats as a hard Forbidden rather than an empty result set.
  // Both "no docs" and "Forbidden" are acceptable proof of "sees nothing" for these tests.
  const res = await payload.find({
    collection: 'photos',
    overrideAccess: false,
    user: user ?? undefined,
    where: { id: { equals: id } },
    disableErrors: true,
  })
  return res.totalDocs
}

describe('photo visibility', () => {
  it('mitglied sees published photo of visible person', async () => {
    const p = await payload.create({ collection: 'people', data: { name: 'Sichtbar' }, overrideAccess: true })
    const photo = await createPublishedPhoto([p.id])
    expect(await countScopedAs(mitgliedA, photo.id)).toBe(1)
  })

  it('hiding a person hides their photos from mitglied immediately', async () => {
    const p = await payload.create({ collection: 'people', data: { name: 'Verborgen' }, overrideAccess: true })
    const photo = await createPublishedPhoto([p.id])
    await payload.update({ collection: 'people', id: p.id, data: { hidden: true }, overrideAccess: true })
    expect(await countScopedAs(mitgliedA, photo.id)).toBe(0)
  })

  it('deleting a hidden person recomputes their photos so a co-tagged photo becomes visible again', async () => {
    const hidden = await payload.create({ collection: 'people', data: { name: 'ZuLoeschen', hidden: true }, overrideAccess: true })
    const photo = await createPublishedPhoto([hidden.id])
    // Hidden person → photo invisible to a normal mitglied.
    expect(await countScopedAs(mitgliedA, photo.id)).toBe(0)
    await payload.delete({ collection: 'people', id: hidden.id, overrideAccess: true })
    // The person (and the photo link) are gone; the afterDelete recompute must clear
    // hasHiddenPerson so the photo — no longer tagging any hidden person — is visible again.
    const check = await payload.findByID({ collection: 'photos', id: photo.id, overrideAccess: true, depth: 0 })
    expect(check.hasHiddenPerson).toBe(false)
    expect(await countScopedAs(mitgliedA, photo.id)).toBe(1)
  })

  it('draft photos are invisible to other mitglieder', async () => {
    const draft = await payload.create({
      collection: 'photos',
      filePath: fixture,
      data: { caption: 'Entwurf', datePrecision: 'unknown', _status: 'draft' },
      overrideAccess: true,
    })
    expect(await findByIdAs(mitgliedA, draft.id)).toBeNull()
  })

  it('soft-deleted photos are invisible to mitglied', async () => {
    const photo = await createPublishedPhoto()
    await payload.update({
      collection: 'photos',
      id: photo.id,
      data: { deletedAt: new Date().toISOString() },
      overrideAccess: true,
    })
    expect(await findByIdAs(mitgliedA, photo.id)).toBeNull()
  })

  it('anonymous users see no photos, published or draft', async () => {
    const p = await payload.create({ collection: 'people', data: { name: 'Öffentlich' }, overrideAccess: true })
    const published = await createPublishedPhoto([p.id])
    const draft = await payload.create({
      collection: 'photos',
      filePath: fixture,
      data: { caption: 'Entwurf', datePrecision: 'unknown', _status: 'draft' },
      overrideAccess: true,
    })
    expect(await findByIdAs(null, published.id)).toBeNull()
    expect(await findByIdAs(null, draft.id)).toBeNull()
    expect(await countScopedAs(null, published.id)).toBe(0)
  })

  it('uploader sees their own draft; a different mitglied does not', async () => {
    const draft = await createPhotoAs(mitgliedA, { _status: 'draft' })
    expect(await findByIdAs(mitgliedA, draft.id)).not.toBeNull()
    expect(await findByIdAs(mitgliedB, draft.id)).toBeNull()
  })

  it("uploader's own published photo of a hidden person is not visible to the uploader (consent revocation is absolute)", async () => {
    const p = await payload.create({ collection: 'people', data: { name: 'WirdVerborgen' }, overrideAccess: true })
    const photo = await createPhotoAs(mitgliedA, { _status: 'published', people: [p.id] })
    expect(await findByIdAs(mitgliedA, photo.id)).not.toBeNull()
    await payload.update({ collection: 'people', id: p.id, data: { hidden: true }, overrideAccess: true })
    expect(await findByIdAs(mitgliedA, photo.id)).toBeNull()
  })
})

describe('photo update access (uploader cannot bypass curator moderation)', () => {
  it('uploader cannot self-publish their own draft', async () => {
    const draft = await createPhotoAs(mitgliedA, { _status: 'draft' })
    await expect(
      payload.update({
        collection: 'photos',
        id: draft.id,
        data: { _status: 'published' },
        user: mitgliedA,
        overrideAccess: false,
      }),
    ).rejects.toThrow()
    const check = await payload.findByID({ collection: 'photos', id: draft.id, overrideAccess: true })
    expect(check._status).toBe('draft')
  })

  it('uploader cannot un-delete a curator-binned draft', async () => {
    const draft = await createPhotoAs(mitgliedA, { _status: 'draft' })
    await payload.update({
      collection: 'photos',
      id: draft.id,
      data: { deletedAt: new Date().toISOString() },
      overrideAccess: true,
    })
    // Document-level access still allows this update (own draft) — but the deletedAt field
    // itself must be protected by field-level access so the value is silently ignored.
    await payload.update({
      collection: 'photos',
      id: draft.id,
      data: { deletedAt: null },
      user: mitgliedA,
      overrideAccess: false,
    })
    const check = await payload.findByID({ collection: 'photos', id: draft.id, overrideAccess: true })
    expect(check.deletedAt).toBeTruthy()
  })

  it('uploader cannot reassign the uploader field on their own draft', async () => {
    const draft = await createPhotoAs(mitgliedA, { _status: 'draft' })
    await payload.update({
      collection: 'photos',
      id: draft.id,
      data: { uploader: mitgliedB.id },
      user: mitgliedA,
      overrideAccess: false,
    })
    const check = await payload.findByID({ collection: 'photos', id: draft.id, overrideAccess: true, depth: 0 })
    expect(check.uploader).toBe(mitgliedA.id)
  })
})

describe('photo create access (uploader cannot bypass moderation at creation)', () => {
  it('mitglied create with _status: published results in a draft document', async () => {
    const photo = await payload.create({
      collection: 'photos',
      filePath: fixture,
      data: { caption: 'Selbstpublikation', datePrecision: 'unknown', _status: 'published' },
      user: mitgliedA,
      overrideAccess: false,
    })
    const check = await payload.findByID({ collection: 'photos', id: photo.id, overrideAccess: true })
    expect(check._status).toBe('draft')
  })

  it('kurator create with _status: published stays published', async () => {
    const photo = await payload.create({
      collection: 'photos',
      filePath: fixture,
      data: { caption: 'Kuratiert veröffentlicht', datePrecision: 'unknown', _status: 'published' },
      user: kurator,
      overrideAccess: false,
    })
    const check = await payload.findByID({ collection: 'photos', id: photo.id, overrideAccess: true })
    expect(check._status).toBe('published')
  })

  it('mitglied create with deletedAt set is stored without deletedAt (create-time self-bin blocked)', async () => {
    const photo = await payload.create({
      collection: 'photos',
      filePath: fixture,
      data: { caption: 'Selbstloeschung', datePrecision: 'unknown', deletedAt: new Date().toISOString() },
      user: mitgliedA,
      overrideAccess: false,
    })
    const check = await payload.findByID({ collection: 'photos', id: photo.id, overrideAccess: true })
    expect(check.deletedAt).toBeFalsy()
  })
})
