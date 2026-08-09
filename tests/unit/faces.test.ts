import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  l2Normalise,
  cosineSimilarity,
  roundEmbedding,
  normalizeBox,
  boxIoU,
  nms,
  similarityTransform,
  invertSimilarity,
  applySimilarity,
  bestMatchPerPerson,
  ARCFACE_TEMPLATE_112,
  facesEnabled,
  modelsDir,
  similarityThreshold,
  detThreshold,
} from '@/lib/faces'

// Final review, H1: these four env-reading functions were the only uncovered lines in this file
// — and the coupled trap the review flagged (`Number('')` is `0`, not `NaN`) was invisible
// without a test exercising the blank-string case specifically. `vi.unstubAllEnvs()` in afterEach
// keeps each case's env stub from leaking into the next.
describe('facesEnabled / modelsDir / similarityThreshold / detThreshold (env parsing)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe('facesEnabled', () => {
    it('is true when unset', () => {
      vi.stubEnv('FACE_DETECTION_ENABLED', undefined)
      expect(facesEnabled()).toBe(true)
    })
    it('is false only for the literal string "false"', () => {
      vi.stubEnv('FACE_DETECTION_ENABLED', 'false')
      expect(facesEnabled()).toBe(false)
    })
    it('is true for anything else, including a blank string', () => {
      vi.stubEnv('FACE_DETECTION_ENABLED', '')
      expect(facesEnabled()).toBe(true)
    })
  })

  describe('modelsDir', () => {
    it('falls back to models/faces when unset', () => {
      vi.stubEnv('FACE_MODELS_DIR', undefined)
      expect(modelsDir()).toBe('models/faces')
    })
    it('falls back to models/faces when blank', () => {
      vi.stubEnv('FACE_MODELS_DIR', '')
      expect(modelsDir()).toBe('models/faces')
    })
    it('uses the env value when set', () => {
      vi.stubEnv('FACE_MODELS_DIR', '/custom/models')
      expect(modelsDir()).toBe('/custom/models')
    })
  })

  describe('similarityThreshold', () => {
    it('defaults to 0.4 when unset', () => {
      vi.stubEnv('FACE_SIMILARITY_THRESHOLD', undefined)
      expect(similarityThreshold()).toBe(0.4)
    })
    it('defaults to 0.4 for a blank string, not 0 (the coupled trap: Number("") === 0)', () => {
      vi.stubEnv('FACE_SIMILARITY_THRESHOLD', '')
      expect(similarityThreshold()).toBe(0.4)
    })
    it('defaults to 0.4 for a whitespace-only string', () => {
      vi.stubEnv('FACE_SIMILARITY_THRESHOLD', '   ')
      expect(similarityThreshold()).toBe(0.4)
    })
    it('parses a valid numeric override', () => {
      vi.stubEnv('FACE_SIMILARITY_THRESHOLD', '0.55')
      expect(similarityThreshold()).toBe(0.55)
    })
    it('defaults to 0.4 for a non-numeric value', () => {
      vi.stubEnv('FACE_SIMILARITY_THRESHOLD', 'garbage')
      expect(similarityThreshold()).toBe(0.4)
    })
  })

  describe('detThreshold', () => {
    it('defaults to 0.5 when unset', () => {
      vi.stubEnv('FACE_DET_THRESHOLD', undefined)
      expect(detThreshold()).toBe(0.5)
    })
    it('defaults to 0.5 for a blank string, not 0', () => {
      vi.stubEnv('FACE_DET_THRESHOLD', '')
      expect(detThreshold()).toBe(0.5)
    })
    it('parses a valid numeric override', () => {
      vi.stubEnv('FACE_DET_THRESHOLD', '0.55')
      expect(detThreshold()).toBe(0.55)
    })
    it('defaults to 0.5 for a non-numeric value', () => {
      vi.stubEnv('FACE_DET_THRESHOLD', 'garbage')
      expect(detThreshold()).toBe(0.5)
    })
  })
})

describe('l2Normalise', () => {
  it('makes the vector unit length', () => {
    const v = l2Normalise([3, 4])
    expect(v[0]).toBeCloseTo(0.6, 10)
    expect(v[1]).toBeCloseTo(0.8, 10)
  })
  it('leaves a zero vector alone instead of dividing by zero', () => {
    expect(l2Normalise([0, 0])).toEqual([0, 0])
  })
})

describe('cosineSimilarity', () => {
  const a = l2Normalise([1, 0, 0])
  it('is 1 for identical, 0 for orthogonal, -1 for opposite', () => {
    expect(cosineSimilarity(a, l2Normalise([1, 0, 0]))).toBeCloseTo(1, 10)
    expect(cosineSimilarity(a, l2Normalise([0, 1, 0]))).toBeCloseTo(0, 10)
    expect(cosineSimilarity(a, l2Normalise([-1, 0, 0]))).toBeCloseTo(-1, 10)
  })
  it('returns 0 on a length mismatch rather than reading past the end', () => {
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0)
  })
})

describe('roundEmbedding', () => {
  it('rounds to 6 decimals and returns a plain array', () => {
    const out = roundEmbedding(Float32Array.from([0.12345678, -0.87654321]))
    expect(Array.isArray(out)).toBe(true)
    expect(out).toEqual([0.123457, -0.876543])
  })
})

describe('normalizeBox', () => {
  it('divides by the image dimensions', () => {
    expect(normalizeBox({ xMin: 100, yMin: 50, xMax: 300, yMax: 250 }, 400, 500)).toEqual({
      xMin: 0.25, yMin: 0.1, xMax: 0.75, yMax: 0.5,
    })
  })
  it('clamps values that fall outside the image', () => {
    const b = normalizeBox({ xMin: -20, yMin: -5, xMax: 500, yMax: 900 }, 400, 500)
    expect(b).toEqual({ xMin: 0, yMin: 0, xMax: 1, yMax: 1 })
  })
})

describe('boxIoU', () => {
  const a = { xMin: 0, yMin: 0, xMax: 10, yMax: 10 }
  it('is 1 for identical boxes', () => expect(boxIoU(a, a)).toBeCloseTo(1, 10))
  it('is 0 for disjoint boxes', () =>
    expect(boxIoU(a, { xMin: 20, yMin: 20, xMax: 30, yMax: 30 })).toBe(0))
  it('is 1/3 for two boxes overlapping in half their area', () =>
    // intersection 50, union 150
    expect(boxIoU(a, { xMin: 5, yMin: 0, xMax: 15, yMax: 10 })).toBeCloseTo(1 / 3, 10))
  it('is 0 for a zero-area box instead of NaN', () =>
    expect(boxIoU(a, { xMin: 5, yMin: 5, xMax: 5, yMax: 5 })).toBe(0))
})

describe('nms', () => {
  it('keeps the highest-scoring box and drops its near-duplicates', () => {
    const kept = nms(
      [
        { box: { xMin: 0, yMin: 0, xMax: 10, yMax: 10 }, score: 0.9, kps: [] },
        { box: { xMin: 1, yMin: 1, xMax: 11, yMax: 11 }, score: 0.8, kps: [] },
        { box: { xMin: 50, yMin: 50, xMax: 60, yMax: 60 }, score: 0.7, kps: [] },
      ],
      0.4,
    )
    expect(kept.map((d) => d.score)).toEqual([0.9, 0.7])
  })
})

describe('similarityTransform', () => {
  it('recovers a known rotation + scale + translation exactly', () => {
    // ground truth: scale 2, rotate 90°, translate (5, -3)
    const t = { a: 0, b: 2, tx: 5, ty: -3 } // [[a,-b],[b,a]] = [[0,-2],[2,0]]
    const src: [number, number][] = [
      [0, 0], [1, 0], [0, 1], [2, 3], [-1, 4],
    ]
    const dst = src.map((p) => applySimilarity(t, p))
    const got = similarityTransform(src, dst)
    expect(got.a).toBeCloseTo(t.a, 8)
    expect(got.b).toBeCloseTo(t.b, 8)
    expect(got.tx).toBeCloseTo(t.tx, 8)
    expect(got.ty).toBeCloseTo(t.ty, 8)
  })

  it('maps the ArcFace template onto itself as the identity', () => {
    const t = similarityTransform(ARCFACE_TEMPLATE_112, ARCFACE_TEMPLATE_112)
    expect(t.a).toBeCloseTo(1, 8)
    expect(t.b).toBeCloseTo(0, 8)
    expect(t.tx).toBeCloseTo(0, 6)
    expect(t.ty).toBeCloseTo(0, 6)
  })
})

describe('invertSimilarity', () => {
  it('round-trips a point back to itself', () => {
    const t = { a: 1.5, b: -0.4, tx: 12, ty: -7 }
    const inv = invertSimilarity(t)
    const p: [number, number] = [3, 9]
    const back = applySimilarity(inv, applySimilarity(t, p))
    expect(back[0]).toBeCloseTo(p[0], 8)
    expect(back[1]).toBeCloseTo(p[1], 8)
  })
})

describe('bestMatchPerPerson', () => {
  const index = [
    { personId: 1, embedding: l2Normalise([1, 0, 0]) },
    { personId: 1, embedding: l2Normalise([0.9, 0.1, 0]) },
    { personId: 2, embedding: l2Normalise([0, 1, 0]) },
  ]
  it('returns the best-scoring person above the threshold', () => {
    const m = bestMatchPerPerson(l2Normalise([1, 0, 0]), index, 0.5)
    expect(m).not.toBeNull()
    expect(m!.personId).toBe(1)
    expect(m!.similarity).toBeCloseTo(1, 8)
  })
  it('returns null when nothing clears the threshold', () => {
    expect(bestMatchPerPerson(l2Normalise([0, 0, 1]), index, 0.5)).toBeNull()
  })
  it('returns null for an empty index', () => {
    expect(bestMatchPerPerson(l2Normalise([1, 0, 0]), [], 0.5)).toBeNull()
  })
})
