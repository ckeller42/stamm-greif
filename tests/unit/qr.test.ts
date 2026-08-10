import { describe, it, expect } from 'vitest'
import { qrSvg } from '@/lib/qr'

describe('qrSvg', () => {
  it('produces a self-contained svg with a path', () => {
    const svg = qrSvg('https://archiv.stamm-greif.de/api/kiosk/download?d=abc.def')
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('viewBox="0 0')
    expect(svg).toContain('<path')
    expect(svg).not.toContain('http://www.w3.org/1999/xlink') // no external refs
  })

  it('is deterministic for the same input', () => {
    const a = qrSvg('same')
    const b = qrSvg('same')
    expect(a).toBe(b)
  })

  it('handles a long URL and does not throw on empty', () => {
    expect(() => qrSvg('x'.repeat(300))).not.toThrow()
    expect(() => qrSvg('')).not.toThrow()
  })
})
