import { describe, it, expect, vi } from 'vitest'
import {
  collectFotobuchPhotos,
  fotobuchPhotoWhere,
  FotobuchHiddenPersonError,
  FOTOBUCH_MAX_PHOTOS,
} from '@/lib/fotobuch-query'

const photo = (id: number) => ({ id, caption: `p${id}`, filename: `p${id}.jpg` })

describe('fotobuchPhotoWhere — the consent clause', () => {
  it('pins the exact AND-terms (published, never hidden person, never binned)', () => {
    expect(fotobuchPhotoWhere()).toEqual({
      and: [
        { _status: { equals: 'published' } },
        { hasHiddenPerson: { not_equals: true } },
        { deletedAt: { exists: false } },
      ],
    })
  })
})

describe('collectFotobuchPhotos', () => {
  it('event path: queries photos for the event with the consent where, sorted & capped', async () => {
    const docs = [photo(1), photo(2)]
    const find = vi.fn(async () => ({ docs }))
    const payload = { find } as any
    const out = await collectFotobuchPhotos(payload, { type: 'event', id: 9 })
    expect(out).toEqual(docs)
    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'photos',
        where: expect.objectContaining({
          and: [expect.objectContaining({ event: { equals: 9 } }), fotobuchPhotoWhere()],
        }),
        sort: ['dateSortKey', 'id'],
        limit: FOTOBUCH_MAX_PHOTOS,
        overrideAccess: true,
      }),
    )
  })

  it('person path: refuses a hidden person (403 signal, no photo assembly)', async () => {
    const payload = {
      findByID: vi.fn(async ({ collection }: any) => (collection === 'people' ? { hidden: true } : undefined)),
      find: vi.fn(),
    } as any
    await expect(collectFotobuchPhotos(payload, { type: 'person', id: 4 })).rejects.toBeInstanceOf(
      FotobuchHiddenPersonError,
    )
    expect(payload.find as any).not.toHaveBeenCalled()
  })

  it('person path: visible person -> photos linked via people in [id]', async () => {
    const docs = [photo(5)]
    const payload = {
      findByID: vi.fn(async () => ({ hidden: false })),
      find: vi.fn(async () => ({ docs })),
    } as any
    await collectFotobuchPhotos(payload, { type: 'person', id: 4 })
    expect(payload.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          and: [expect.objectContaining({ people: { in: [4] } }), fotobuchPhotoWhere()],
        }),
      }),
    )
  })

  it('series path: resolves the series events, then queries photos by event id set', async () => {
    const payload = {
      findByID: vi.fn(),
      find: vi.fn(async (args: any) =>
        args.collection === 'events'
          ? { docs: [{ id: 11 }, { id: 12 }] }
          : { docs: [photo(20), photo(21)] },
      ),
    } as any
    const out = await collectFotobuchPhotos(payload, { type: 'series', id: 3 })
    expect(out).toEqual([photo(20), photo(21)])
    const calls = (payload.find as any).mock.calls as any[]
    expect(calls[0][0]).toEqual(expect.objectContaining({ collection: 'events', where: { series: { equals: 3 } } }))
    expect(calls[1][0]).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({
          and: [expect.objectContaining({ event: { in: [11, 12] } }), fotobuchPhotoWhere()],
        }),
      }),
    )
  })

  it('series path: a series with no events returns nothing without querying photos', async () => {
    const find = vi.fn(async (args: any) => (args.collection === 'events' ? { docs: [] } : { docs: [photo(1)] }))
    const payload = { findByID: vi.fn(), find } as any
    const out = await collectFotobuchPhotos(payload, { type: 'series', id: 3 })
    expect(out).toEqual([])
    expect(find).toHaveBeenCalledTimes(1) // only the events query
  })

  it('excludeIds removes already-retried photos from the batch', async () => {
    const payload = {
      findByID: vi.fn(),
      find: vi.fn(async () => ({ docs: [photo(1), photo(2), photo(3)] })),
    } as any
    const out = await collectFotobuchPhotos(payload, { type: 'event', id: 9, excludeIds: [3] })
    expect(out.map((p: any) => p.id)).toEqual([1, 2])
  })

  it('person path: a missing person (disableErrors -> undefined) falls through to an empty-style query', async () => {
    const payload = {
      findByID: vi.fn(async () => undefined),
      find: vi.fn(async () => ({ docs: [] })),
    } as any
    const out = await collectFotobuchPhotos(payload, { type: 'person', id: 4 })
    expect(out).toEqual([])
  })
})
