import { describe, it, expect, vi } from 'vitest'
import { purgeSuggestionsIfConsentWithdrawn } from '@/lib/face-consent-purge'
import type { PayloadRequest } from 'payload'

// A fake PayloadRequest whose payload.findByID returns a chosen photo consent state, whose
// payload.find returns a chosen hidden-people set, and which records any face-suggestions delete.
// Only the methods the helper touches are implemented.
function fakeReq(
  photoState: unknown,
  hiddenPeople: Array<{ id: number | string }> = [],
  deletedRows: Array<{ id: number | string }> = [],
) {
  const del = vi.fn().mockResolvedValue({ docs: deletedRows })
  const findByID = vi.fn().mockResolvedValue(photoState)
  const find = vi.fn().mockResolvedValue({ docs: hiddenPeople })
  const req = {
    payload: { findByID, find, delete: del, logger: { info: vi.fn() } },
  } as unknown as PayloadRequest
  return { req, del, findByID, find }
}

describe('purgeSuggestionsIfConsentWithdrawn (C3 TOCTOU close)', () => {
  it('does nothing when no rows were written', async () => {
    const { req, del, findByID } = fakeReq({ _status: 'published' })
    expect(await purgeSuggestionsIfConsentWithdrawn(req, 1, 0)).toEqual({ allWithdrawn: false, purgedSuggested: 0 })
    expect(findByID).not.toHaveBeenCalled()
    expect(del).not.toHaveBeenCalled()
  })

  it('keeps rows when the photo is still valid and no matched person was hidden', async () => {
    const { req, del } = fakeReq({ _status: 'published', hasHiddenPerson: false, deletedAt: null }, [])
    expect(await purgeSuggestionsIfConsentWithdrawn(req, 1, 3)).toEqual({ allWithdrawn: false, purgedSuggested: 0 })
    expect(del).not.toHaveBeenCalled()
  })

  it('purges ALL written offen rows when a person tagged on the photo was hidden during inference', async () => {
    const { req, del } = fakeReq({ _status: 'published', hasHiddenPerson: true, deletedAt: null })
    expect(await purgeSuggestionsIfConsentWithdrawn(req, 42, 2)).toEqual({ allWithdrawn: true, purgedSuggested: 2 })
    expect(del).toHaveBeenCalledOnce()
    const arg = del.mock.calls[0][0]
    expect(arg.collection).toBe('face-suggestions')
    expect(arg.where).toEqual({ and: [{ photo: { equals: 42 } }, { status: { equals: 'offen' } }] })
    expect(arg.overrideAccess).toBe(true)
  })

  it('purges when the photo was binned during inference', async () => {
    const { req, del } = fakeReq({ _status: 'published', hasHiddenPerson: false, deletedAt: '2026-01-01T00:00:00.000Z' })
    expect(await purgeSuggestionsIfConsentWithdrawn(req, 7, 1)).toEqual({ allWithdrawn: true, purgedSuggested: 1 })
    expect(del).toHaveBeenCalledOnce()
  })

  it('purges when the photo was unpublished during inference', async () => {
    const { req, del } = fakeReq({ _status: 'draft', hasHiddenPerson: false, deletedAt: null })
    expect(await purgeSuggestionsIfConsentWithdrawn(req, 7, 1)).toEqual({ allWithdrawn: true, purgedSuggested: 1 })
    expect(del).toHaveBeenCalledOnce()
  })

  it('purges when the photo vanished entirely (hard delete race)', async () => {
    const { req, del } = fakeReq(null)
    expect(await purgeSuggestionsIfConsentWithdrawn(req, 7, 1)).toEqual({ allWithdrawn: true, purgedSuggested: 1 })
    expect(del).toHaveBeenCalledOnce()
  })

  it('does no person query at all when the run suggested nobody (hot path stays free)', async () => {
    const { req, del, find } = fakeReq({ _status: 'published', hasHiddenPerson: false, deletedAt: null })
    // writtenCount 4, but every suggestion had a null match → no suggestedPersonIds passed.
    expect(await purgeSuggestionsIfConsentWithdrawn(req, 3, 4, [])).toEqual({ allWithdrawn: false, purgedSuggested: 0 })
    expect(find).not.toHaveBeenCalled()
    expect(del).not.toHaveBeenCalled()
  })

  // C3 follow-up (reviewer Minor): the photo itself is still valid, but a written row NAMES a person
  // (via embedding match) who was hidden mid-inference and is not tagged on this photo — so the
  // photo-level flags never flipped. Those rows must still be purged, scoped to the hidden person,
  // and the person query is scoped to only the ids suggested this run (never a full-table scan).
  it('purges only the rows naming a now-hidden matched person when the photo is otherwise valid', async () => {
    const { req, del, find } = fakeReq(
      { _status: 'published', hasHiddenPerson: false, deletedAt: null },
      [{ id: 5 }],
      [{ id: 100 }], // the one offen row that named person 5
    )
    // photo stays valid, but 1 row named a now-hidden person → reported as a partial purge.
    expect(await purgeSuggestionsIfConsentWithdrawn(req, 3, 4, [5, 9, 5])).toEqual({ allWithdrawn: false, purgedSuggested: 1 })
    // The person query is scoped to the (deduped) suggested ids AND hidden.
    expect(find).toHaveBeenCalledOnce()
    expect(find.mock.calls[0][0].where).toEqual({ and: [{ id: { in: [5, 9] } }, { hidden: { equals: true } }] })
    // Only person 5 came back hidden → delete scoped to that person's rows on this photo.
    expect(del).toHaveBeenCalledOnce()
    expect(del.mock.calls[0][0].where).toEqual({
      and: [
        { photo: { equals: 3 } },
        { status: { equals: 'offen' } },
        { suggestedPerson: { in: [5] } },
      ],
    })
  })
})
