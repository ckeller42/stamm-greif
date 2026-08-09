// Pure face maths. No I/O, no onnxruntime — everything here is unit-tested and shared by the
// model layer (src/lib/face-model.ts), the detection job and the /gesichter page.

export type Box = { xMin: number; yMin: number; xMax: number; yMax: number }
export type Detection = { box: Box; score: number; kps: [number, number][] }
/** Similarity transform [[a,-b],[b,a]]·p + (tx,ty): rotation + uniform scale + translation. */
export type Similarity = { a: number; b: number; tx: number; ty: number }

/**
 * The five reference points ArcFace expects in a 112x112 aligned crop (left eye, right eye,
 * nose, left mouth corner, right mouth corner) — the standard InsightFace template. The
 * detector emits its keypoints in this same order, so alignment is a direct 5-point fit.
 */
export const ARCFACE_TEMPLATE_112: [number, number][] = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
]

/** Two detections overlapping more than this are treated as the same face (re-run idempotency). */
export const IOU_DUPLICATE_THRESHOLD = 0.5

export function facesEnabled(): boolean {
  return process.env.FACE_DETECTION_ENABLED !== 'false'
}

export function modelsDir(): string {
  return process.env.FACE_MODELS_DIR || 'models/faces'
}

/**
 * Cosine threshold above which a match becomes a suggestion. InsightFace's own guidance puts
 * 1:1 thresholds for their recognition packs at 0.30–0.45 over L2-normalised embeddings and says
 * to recompute per population — so this is a starting point to tune on real data, not a constant
 * of nature. Env-tunable precisely so it can be walked in without a deploy. A false positive
 * costs a kurator one click; a false negative costs a suggestion that never appears.
 */
export function similarityThreshold(): number {
  const v = Number(process.env.FACE_SIMILARITY_THRESHOLD)
  return Number.isFinite(v) ? v : 0.4
}

/** Minimum detector confidence for a box to be considered a face at all. */
export function detThreshold(): number {
  const v = Number(process.env.FACE_DET_THRESHOLD)
  return Number.isFinite(v) ? v : 0.5
}

export function l2Normalise(v: ArrayLike<number>): number[] {
  let sum = 0
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i]
  const norm = Math.sqrt(sum)
  const out = new Array<number>(v.length)
  // A zero vector has no direction; dividing would produce NaN and poison every later
  // comparison, so pass it through unchanged and let the caller's threshold reject it.
  if (norm === 0) {
    for (let i = 0; i < v.length; i++) out[i] = v[i]
    return out
  }
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm
  return out
}

/** Dot product — correct as cosine ONLY for already-L2-normalised inputs, which is all we store. */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) return 0
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot
}

/** 6 decimals is far below cosine's sensitivity and roughly halves the stored JSON. */
export function roundEmbedding(v: ArrayLike<number>): number[] {
  const out = new Array<number>(v.length)
  for (let i = 0; i < v.length; i++) out[i] = Math.round(v[i] * 1e6) / 1e6
  return out
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n)

/** Pixels → 0…1 fractions, so one stored row crops correctly from thumbnail, web or original. */
export function normalizeBox(box: Box, width: number, height: number): Box {
  return {
    xMin: clamp01(box.xMin / width),
    yMin: clamp01(box.yMin / height),
    xMax: clamp01(box.xMax / width),
    yMax: clamp01(box.yMax / height),
  }
}

export function boxIoU(a: Box, b: Box): number {
  const w = Math.min(a.xMax, b.xMax) - Math.max(a.xMin, b.xMin)
  const h = Math.min(a.yMax, b.yMax) - Math.max(a.yMin, b.yMin)
  if (w <= 0 || h <= 0) return 0
  const inter = w * h
  const areaA = Math.max(0, a.xMax - a.xMin) * Math.max(0, a.yMax - a.yMin)
  const areaB = Math.max(0, b.xMax - b.xMin) * Math.max(0, b.yMax - b.yMin)
  const union = areaA + areaB - inter
  return union <= 0 ? 0 : inter / union
}

/** Greedy non-maximum suppression, highest score first. */
export function nms(dets: Detection[], iouThreshold: number): Detection[] {
  const sorted = [...dets].sort((x, y) => y.score - x.score)
  const kept: Detection[] = []
  for (const d of sorted) {
    if (kept.some((k) => boxIoU(k.box, d.box) > iouThreshold)) continue
    kept.push(d)
  }
  return kept
}

export function applySimilarity(t: Similarity, p: [number, number]): [number, number] {
  return [t.a * p[0] - t.b * p[1] + t.tx, t.b * p[0] + t.a * p[1] + t.ty]
}

/**
 * Least-squares similarity transform (rotation + uniform scale + translation, no reflection)
 * mapping `src` onto `dst`. Closed form — no SVD needed for this transform class: writing the
 * 2-D points as complex numbers, the least-squares fit of `q = z·p + t` has
 * `z = Σ(a_i · conj-dot b_i) / Σ|a_i|²` over the centred points, whose real part is `scale·cosθ`
 * and imaginary part `scale·sinθ`. Deliberately NOT a full affine fit: allowing shear/reflection
 * would let a bad keypoint warp the face instead of being averaged out, and ArcFace expects a
 * rigid+scale alignment onto ARCFACE_TEMPLATE_112.
 */
export function similarityTransform(
  src: [number, number][],
  dst: [number, number][],
): Similarity {
  const n = Math.min(src.length, dst.length)
  if (n === 0) return { a: 1, b: 0, tx: 0, ty: 0 }
  let sx = 0, sy = 0, dx = 0, dy = 0
  for (let i = 0; i < n; i++) {
    sx += src[i][0]; sy += src[i][1]
    dx += dst[i][0]; dy += dst[i][1]
  }
  sx /= n; sy /= n; dx /= n; dy /= n
  let dot = 0, cross = 0, den = 0
  for (let i = 0; i < n; i++) {
    const ax = src[i][0] - sx, ay = src[i][1] - sy
    const bx = dst[i][0] - dx, by = dst[i][1] - dy
    dot += ax * bx + ay * by
    cross += ax * by - ay * bx
    den += ax * ax + ay * ay
  }
  // Degenerate input (all five keypoints identical): fall back to pure translation rather than
  // dividing by zero and emitting NaNs into the warp.
  if (den === 0) return { a: 1, b: 0, tx: dx - sx, ty: dy - sy }
  const a = dot / den
  const b = cross / den
  return { a, b, tx: dx - (a * sx - b * sy), ty: dy - (b * sx + a * sy) }
}

/** Inverse of a similarity transform — used for backward (destination→source) sampling. */
export function invertSimilarity(t: Similarity): Similarity {
  const det = t.a * t.a + t.b * t.b
  if (det === 0) return { a: 1, b: 0, tx: 0, ty: 0 }
  const a = t.a / det
  const b = -t.b / det
  return { a, b, tx: -(a * t.tx - b * t.ty), ty: -(b * t.tx + a * t.ty) }
}

export type IndexedFace = { personId: number | string; embedding: number[] }

/**
 * Best person for one probe embedding: score every indexed face, keep each person's best score,
 * return the top person if it clears `threshold`. Linear scan — fine into the low thousands of
 * confirmed faces; beyond ~10 000 this wants pgvector (spec §4).
 */
export function bestMatchPerPerson(
  probe: number[],
  index: IndexedFace[],
  threshold: number,
): { personId: number | string; similarity: number } | null {
  const best = new Map<string, { personId: number | string; similarity: number }>()
  for (const entry of index) {
    const sim = cosineSimilarity(probe, entry.embedding)
    const key = String(entry.personId)
    const prev = best.get(key)
    if (!prev || sim > prev.similarity) best.set(key, { personId: entry.personId, similarity: sim })
  }
  let top: { personId: number | string; similarity: number } | null = null
  for (const v of best.values()) if (!top || v.similarity > top.similarity) top = v
  return top && top.similarity >= threshold ? top : null
}
