// Integration test: regression net for the access-control matrix (Task 13). Local API only.
//
// Denial-assertion style: for photos/people/events, `find` with overrideAccess: false and
// user: null resolves an access function that returns boolean `false` (not a Where clause),
// which Payload treats as a hard Forbidden and throws — verified empirically against this
// Payload version (3.87.0) before writing this file. So `.rejects.toThrow()` is used directly,
// matching the brief's default (no disableErrors adaptation needed for these three).
//
// Emails are unique-per-run (`${role}${Date.now()}@example.com`) so this file is safe to run
// repeatedly against a dirty test DB without manual resets, per the same discipline used in
// hidden-person.int.test.ts and (after the Task 13 hygiene fix) invites.int.test.ts.

import { describe, it, expect, beforeAll } from 'vitest'
import { getPayload, type Payload } from 'payload'
import config from '@payload-config'

let payload: Payload
let admin: any, kurator: any, mitglied: any

beforeAll(async () => {
  payload = await getPayload({ config: await config })
  const mk = (role: 'admin' | 'kurator' | 'mitglied') =>
    payload.create({
      collection: 'users',
      data: { name: role, email: `${role}${Date.now()}@example.com`, password: 'geheim123', role },
      overrideAccess: true,
    })
  ;[admin, kurator, mitglied] = await Promise.all([mk('admin'), mk('kurator'), mk('mitglied')])
})

describe('access matrix', () => {
  it('anonymous reads nothing from photos/people/events', async () => {
    for (const collection of ['photos', 'people', 'events'] as const) {
      await expect(
        payload.find({ collection, overrideAccess: false, user: null }),
      ).rejects.toThrow() // Payload throws Forbidden when access returns boolean false
    }
  })

  it('mitglied cannot create people or groups', async () => {
    await expect(
      payload.create({ collection: 'people', data: { name: 'X' }, overrideAccess: false, user: mitglied }),
    ).rejects.toThrow()
    await expect(
      payload.create({ collection: 'groups', data: { name: 'X', stufe: 'sippe' }, overrideAccess: false, user: mitglied }),
    ).rejects.toThrow()
  })

  it('kurator can create people; only admin can delete them', async () => {
    const p = await payload.create({ collection: 'people', data: { name: 'K-Person' }, overrideAccess: false, user: kurator })
    await expect(
      payload.delete({ collection: 'people', id: p.id, overrideAccess: false, user: kurator }),
    ).rejects.toThrow()
    await payload.delete({ collection: 'people', id: p.id, overrideAccess: false, user: admin }) // must not throw
  })

  it('mitglied cannot change their own role', async () => {
    // Document-level access (isAdminOrSelf) permits a mitglied to update their own user doc,
    // but the `role` field carries its own field-level access restricting updates to admins.
    // Verified empirically: Payload does not throw for a field-level-only denial on an
    // otherwise-permitted document update — it silently drops that field from the write and
    // the call resolves. Same pattern already exercised in hidden-person.int.test.ts for
    // photos.uploader / photos.deletedAt field protection, so this asserts on the persisted
    // value rather than expecting a rejection.
    await payload.update({
      collection: 'users', id: mitglied.id, data: { role: 'admin' }, overrideAccess: false, user: mitglied,
    })
    const check = await payload.findByID({ collection: 'users', id: mitglied.id, overrideAccess: true })
    expect(check.role).toBe('mitglied')
  })

  // Carried from Task 1/2/3 (P2.4 kiosk): kiosk-sessions is admin-only at the COLLECTION level
  // (KioskSessions.ts's access block) — kurators mint/revoke only through /api/kiosk/session,
  // which runs overrideAccess:true; they have no direct CRUD on the collection itself. Regression
  // net for that, now that Task 4 exercises the collection over HTTP for the first time.
  it('kiosk-sessions collection is admin-only, even for a kurator', async () => {
    for (const user of [mitglied, kurator]) {
      await expect(
        payload.find({ collection: 'kiosk-sessions', overrideAccess: false, user }),
      ).rejects.toThrow()
      await expect(
        payload.create({
          collection: 'kiosk-sessions',
          data: { label: 'x', expiresAt: new Date(Date.now() + 3600_000).toISOString() },
          overrideAccess: false,
          user,
        }),
      ).rejects.toThrow()
    }
    const s = await payload.create({
      collection: 'kiosk-sessions',
      data: { label: 'admin-only-check', expiresAt: new Date(Date.now() + 3600_000).toISOString() },
      overrideAccess: false,
      user: admin,
    }) // must not throw
    expect(s.id).toBeTruthy()
  })

  // Carried from Task 1/2/3 (P2.4 kiosk): kioskFreigegeben is the human consent gate for the
  // public beamer (spec §3) — only kurator/admin may set it (Photos.ts field access:
  // isKuratorOrAdminField). A mitglied editing their own still-draft upload (otherwise a
  // permitted document-level update, per canUpdatePhoto) must not be able to mark it kiosk-safe
  // themselves. Same silent-drop-not-throw shape as the role-field test above.
  it('a mitglied cannot set kioskFreigegeben=true on their own photo', async () => {
    const photo = await payload.create({
      collection: 'photos',
      data: { datePrecision: 'year', dateValue: '1990', _status: 'draft', uploader: mitglied.id } as any,
      filePath: 'tests/fixtures/dia.jpg',
      overrideAccess: true,
    })
    await payload.update({
      collection: 'photos', id: photo.id, data: { kioskFreigegeben: true }, overrideAccess: false, user: mitglied,
    })
    const check = await payload.findByID({ collection: 'photos', id: photo.id, overrideAccess: true })
    expect(check.kioskFreigegeben).toBe(false)
  })
})
