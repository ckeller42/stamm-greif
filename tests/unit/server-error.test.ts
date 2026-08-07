import { describe, it, expect } from 'vitest'
import { formatServerError } from '@/lib/server-error'

describe('formatServerError', () => {
  it('valid body -> first error message', () => {
    expect(formatServerError({ errors: [{ message: 'Datei zu groß (Fehler-ID: abc123)' }] }))
      .toBe('Datei zu groß (Fehler-ID: abc123)')
  })
  it('empty object -> null', () => {
    expect(formatServerError({})).toBeNull()
  })
  it('null -> null', () => {
    expect(formatServerError(null)).toBeNull()
  })
  it('empty errors array -> null', () => {
    expect(formatServerError({ errors: [] })).toBeNull()
  })
  it('error entry without message -> null', () => {
    expect(formatServerError({ errors: [{}] })).toBeNull()
  })
  it('null entry -> null', () => {
    expect(formatServerError({ errors: [null] })).toBeNull()
  })
  it('non-object entry -> null', () => {
    expect(formatServerError({ errors: ['x'] })).toBeNull()
  })
})
