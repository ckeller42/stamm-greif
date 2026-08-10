import { describe, it, expect } from 'vitest'
import { kioskPhotoWhere } from '@/lib/kiosk-query'

describe('kioskPhotoWhere', () => {
  it('AND-combines exactly the four consent terms: kioskFreigegeben, published, no hidden person, not deleted', () => {
    const where = kioskPhotoWhere()
    expect(where).toEqual({
      and: [
        { kioskFreigegeben: { equals: true } },
        { _status: { equals: 'published' } },
        { hasHiddenPerson: { not_equals: true } },
        { deletedAt: { exists: false } },
      ],
    })
  })
})
