// Perceptual hash (dHash — "difference hash") for duplicate-photo detection on upload (spec
// P2.2). Pure functions only: the actual pixel decode (sharp) lives in the collection hook that
// calls computeDHash, so this file has no dependency on sharp/Payload and is trivially unit
// testable.
//
// dHash algorithm: shrink the image to a fixed 9x8 grayscale grid, then for each of the 8 rows
// compare each of the 9 pixels against its right-hand neighbor (8 comparisons per row) — 1 bit
// per comparison, 64 bits total, encoded as a 16-character lowercase hex string. Two photos of
// the *same* motif (even re-scanned/re-exported/recompressed) produce nearly identical hashes
// because the 9x8 downsample washes out compression noise while preserving the image's coarse
// light/dark gradient structure; a hamming distance near 0 signals "probably the same shot",
// while an unrelated image's hash differs roughly randomly (hamming distance ~32 out of 64 on
// average).
//
// Known property, deliberately not "fixed": a perfectly flat/solid-color image (no horizontal
// gradient anywhere) hashes to all-zero bits regardless of *which* color it is, because dHash
// only ever compares relative brightness between neighboring pixels, never absolute intensity.
// tests/unit/phash.test.ts pins this explicitly.

const WIDTH = 9
const HEIGHT = 8
const EXPECTED_BYTES = WIDTH * HEIGHT // 72 — one grayscale byte per pixel, no padding/channels.
const HEX_LENGTH = 16 // 64 bits / 4 bits-per-hex-digit

/**
 * Computes a 64-bit dHash from a 72-byte raw grayscale buffer (the output of
 * `sharp(buffer).grayscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer()`), returned as a
 * 16-character lowercase hex string. Pure — does no image decoding itself.
 */
export function computeDHash(raw: Buffer): string {
  if (raw.length !== EXPECTED_BYTES) {
    throw new Error(`computeDHash: expected a ${EXPECTED_BYTES}-byte raw grayscale (9x8) buffer, got ${raw.length}`)
  }
  let bits = 0n
  for (let row = 0; row < HEIGHT; row++) {
    for (let col = 0; col < WIDTH - 1; col++) {
      const left = raw[row * WIDTH + col]
      const right = raw[row * WIDTH + col + 1]
      bits = (bits << 1n) | (left > right ? 1n : 0n)
    }
  }
  return bits.toString(16).padStart(HEX_LENGTH, '0')
}

/**
 * Number of differing bits between two dHash hex strings (0-64). Pure, symmetric, and 0 exactly
 * when the two hashes are identical.
 */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== HEX_LENGTH || b.length !== HEX_LENGTH) {
    throw new Error(`hammingDistance: expected ${HEX_LENGTH}-character hex hashes, got lengths ${a.length}/${b.length}`)
  }
  let xor = BigInt('0x' + a) ^ BigInt('0x' + b)
  let count = 0
  while (xor > 0n) {
    count += Number(xor & 1n)
    xor >>= 1n
  }
  return count
}
