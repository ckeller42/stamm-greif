import { describe, it, expect, vi } from 'vitest'
import { purgeSuggestionsIfConsentWithdrawn } from '@/lib/face-consent-purge'
import type { PayloadRequest } from 'payload'

// A fake PayloadRequest whose payload.findByID returns a chosen photo consent state and records any
// face-suggestions delete. Only the two methods the helper touches are implemented.
function fakeReq(photoState: unknown) {
  const del = vi.fn().mockResolvedValue({ docs: [] })
  const findByID = vi.fn().mockResolvedValue(photoState)
  const req = {
    payload: { findByID, delete: del, logger: { info: vi.fn() } },
  } as unknown as PayloadRequest
  return { req, del, findByID }
}

describe('purgeSuggestionsIfConsentWithdrawn (C3 TOCTOU close)', () => {
  it('does nothing when no rows were written', async () => {
    const { req, del, findByID } = fakeReq({ _status: 'published' })
    expect(await purgeSuggestionsIfConsentWithdrawn(req, 1, 0)).toBe(false)
    expect(findByID).not.toHaveBeenCalled()
    expect(del).not.toHaveBeenCalled()
  })

  it('keeps rows when the photo is still published, visible and un-binned', async () => {
    const { req, del } = fakeReq({ _status: 'published', hasHiddenPerson: false, deletedAt: null })
    expect(await purgeSuggestionsIfConsentWithdrawn(req, 1, 3)).toBe(false)
    expect(del).not.toHaveBeenCalled()
  })

  it('purges the written offen rows when a person was hidden during inference', async () => {
    const { req, del } = fakeReq({ _status: 'published', hasHiddenPerson: true, deletedAt: null })
    expect(await purgeSuggestionsIfConsentWithdrawn(req, 42, 2)).toBe(true)
    expect(del).toHaveBeenCalledOnce()
    const arg = del.mock.calls[0][0]
    expect(arg.collection).toBe('face-suggestions')
    // Scoped to THIS photo's still-open rows only.
    expect(arg.where).toEqual({ and: [{ photo: { equals: 42 } }, { status: { equals: 'offen' } }] })
    expect(arg.overrideAccess).toBe(true)
  })

  it('purges when the photo was binned during inference', async () => {
    const { req, del } = fakeReq({ _status: 'published', hasHiddenPerson: false, deletedAt: '2026-01-01T00:00:00.000Z' })
    expect(await purgeSuggestionsIfConsentWithdrawn(req, 7, 1)).toBe(true)
    expect(del).toHaveBeenCalledOnce()
  })

  it('purges when the photo was unpublished during inference', async () => {
    const { req, del } = fakeReq({ _status: 'draft', hasHiddenPerson: false, deletedAt: null })
    expect(await purgeSuggestionsIfConsentWithdrawn(req, 7, 1)).toBe(true)
    expect(del).toHaveBeenCalledOnce()
  })

  it('purges when the photo vanished entirely (hard delete race)', async () => {
    const { req, del } = fakeReq(null)
    expect(await purgeSuggestionsIfConsentWithdrawn(req, 7, 1)).toBe(true)
    expect(del).toHaveBeenCalledOnce()
  })
})
