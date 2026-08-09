import { describe, it, expect } from 'vitest'
import { computeDHash, hammingDistance } from '@/lib/phash'

// 9x8 = 72 grayscale bytes, matching sharp(...).grayscale().resize(9, 8, { fit: 'fill' }).raw().
function solidBuffer(value: number): Buffer {
  return Buffer.alloc(72, value)
}

// Each of the 8 rows is the same 9-value sequence — dHash only ever compares a pixel against its
// row-neighbor, so the same per-row pattern repeated down all 8 rows is enough to pin the
// algorithm's full 64-bit output deterministically.
function rowPatternBuffer(row: number[]): Buffer {
  if (row.length !== 9) throw new Error('test fixture row must have exactly 9 values')
  return Buffer.from(Array(8).fill(row).flat())
}

describe('computeDHash', () => {
  it('produces a 16-character lowercase hex string', () => {
    const hash = computeDHash(rowPatternBuffer([10, 200, 5, 250, 0, 128, 64, 32, 16]))
    expect(hash).toMatch(/^[0-9a-f]{16}$/)
  })

  it('an ascending gradient (each pixel <= its right neighbor) hashes to all-zero bits', () => {
    const hash = computeDHash(rowPatternBuffer([0, 1, 2, 3, 4, 5, 6, 7, 8]))
    expect(hash).toBe('0000000000000000')
  })

  it('a descending gradient (each pixel > its right neighbor) hashes to all-one bits', () => {
    const hash = computeDHash(rowPatternBuffer([8, 7, 6, 5, 4, 3, 2, 1, 0]))
    expect(hash).toBe('ffffffffffffffff')
  })

  it('a flat/solid-color image hashes to all-zero bits regardless of which color', () => {
    // Known dHash property, not a bug: it only ever compares RELATIVE brightness between
    // neighboring pixels, never absolute intensity, so an image with no horizontal gradient
    // anywhere — all-black, all-white, or any other single flat shade — collapses to the same
    // "no differences found" hash. (left > right is false whenever left === right.)
    expect(computeDHash(solidBuffer(0))).toBe('0000000000000000')
    expect(computeDHash(solidBuffer(255))).toBe('0000000000000000')
  })

  it('all-black vs all-white: identical hashes, hamming distance 0', () => {
    // Direct consequence of the property above — flagged explicitly since it is the one most
    // likely to look surprising at a glance.
    const black = computeDHash(solidBuffer(0))
    const white = computeDHash(solidBuffer(255))
    expect(black).toBe(white)
    expect(hammingDistance(black, white)).toBe(0)
  })

  it('throws on a buffer that is not exactly 72 bytes (9x8 grayscale)', () => {
    expect(() => computeDHash(Buffer.alloc(71))).toThrow(/72-byte/)
    expect(() => computeDHash(Buffer.alloc(73))).toThrow(/72-byte/)
  })
})

describe('hammingDistance', () => {
  it('is 0 for identical hashes', () => {
    const hash = computeDHash(rowPatternBuffer([8, 7, 6, 5, 4, 3, 2, 1, 0]))
    expect(hammingDistance(hash, hash)).toBe(0)
  })

  it('is 64 for fully opposite 64-bit hashes', () => {
    expect(hammingDistance('0000000000000000', 'ffffffffffffffff')).toBe(64)
  })

  it('detects a single-bit flip as distance 1', () => {
    expect(hammingDistance('0000000000000000', '0000000000000001')).toBe(1)
    expect(hammingDistance('8000000000000000', '0000000000000000')).toBe(1)
  })

  it('is symmetric', () => {
    expect(hammingDistance('1234567890abcdef', 'fedcba0987654321')).toBe(
      hammingDistance('fedcba0987654321', '1234567890abcdef'),
    )
  })

  it('throws on malformed (wrong-length) hash input', () => {
    expect(() => hammingDistance('abc', '0000000000000000')).toThrow(/16-character/)
    expect(() => hammingDistance('0000000000000000', 'toolonghexvaluexxx')).toThrow(/16-character/)
  })
})
