import { describe, it, expect } from 'vitest'
import { fotobuchPhotoWhere, FOTOBUCH_MAX_PHOTOS } from '@/lib/fotobuch-query'
import { kioskPhotoWhere } from '@/lib/kiosk-query'

describe('fotobuchPhotoWhere', () => {
  it('ANDs exactly published + not-hidden-person + not-binned', () => {
    expect(fotobuchPhotoWhere()).toEqual({
      and: [
        { _status: { equals: 'published' } },
        { hasHiddenPerson: { not_equals: true } },
        { deletedAt: { exists: false } },
      ],
    })
  })

  it('is the kiosk filter MINUS the kiosk allowlist (no kioskFreigegeben, no OR)', () => {
    const json = JSON.stringify(fotobuchPhotoWhere())
    expect(json).not.toContain('kioskFreigegeben')
    expect(json).not.toContain('"or"')
    // every fotobuch term is present in the kiosk filter (fotobuch ⊂ kiosk terms)
    const kioskTerms = JSON.stringify((kioskPhotoWhere() as { and: unknown[] }).and)
    for (const term of (fotobuchPhotoWhere() as { and: unknown[] }).and) {
      expect(kioskTerms).toContain(JSON.stringify(term))
    }
  })
})

describe('FOTOBUCH_MAX_PHOTOS', () => {
  it('is a sane positive cap', () => {
    expect(FOTOBUCH_MAX_PHOTOS).toBe(300)
  })
})
