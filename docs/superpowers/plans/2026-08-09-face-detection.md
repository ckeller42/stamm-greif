# Face Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In-process face detection + recognition inside the app. Publishing a photo enqueues a job that finds faces, embeds them, and matches them against already-confirmed faces; a kurator confirms or rejects each suggestion on `/gesichter`; confirming tags the person and indexes that face. Setting a person's `hidden` flag hard-deletes all of their face data.

**Architecture:** `onnxruntime-web`'s WASM execution provider, loaded through its **Node** entry point — pure JS + WebAssembly, no native addon, so it runs unchanged in our `node:22-alpine` (musl) image. Two InsightFace `buffalo_s` ONNX models (`det_500m` detector → boxes + 5 keypoints, `w600k_mbf` → 512-d ArcFace embedding) are downloaded with SHA-256 verification in a Dockerfile stage and copied into the image. Embeddings live in our own Postgres on a new `face-suggestions` collection; matching is cosine similarity computed in-process over confirmed rows. Detection runs on the draft→published transition via a Payload job on its own `faces` queue.

**Tech Stack:** Payload 3.87 (collections, custom endpoints, jobs/tasks, hooks), Next.js 16 server components + one small client form, `onnxruntime-web` 1.27 (WASM EP), `sharp` (already a dep, for raw-pixel decode), Postgres `jsonb`.

**Spec:** `docs/superpowers/specs/2026-08-09-face-detection-design.md`

## Global Constraints

- **The live docker stack is untouchable.** Never run `docker compose` against the root `docker-compose.yml` (project `stamm-greif`) — that is the owner's running archive. All local work uses `docker compose -f docker-compose.dev.yml …` (project `stamm-greif-dev`: `db` on :5432, `db-test` on :5433). The only exception is Task 8's post-merge deploy, which is explicitly gated on the user.
- Implementation branch: **`p2-faces`**, branched from `main`. (The spec lives on `p2-faces-spec`.) Every commit ends with the two trailer lines shown by `git log -1 --format=%B` (`Co-Authored-By:` + `Claude-Session:`).
- **Full local gate after every task** — all six must be clean before committing:
  ```sh
  pnpm lint
  pnpm exec tsc --noEmit
  pnpm test:unit
  pnpm test:int          # needs dev server on the TEST db, see Task 2 Step 1
  pnpm exec playwright test --workers=1
  shellcheck scripts/*.sh
  ```
  plus the drift check (below) for any task that touches a collection.
- **Migrations are committed, never auto-pushed.** CI's drift check drops the test schema, runs `pnpm payload migrate`, then `pnpm payload migrate:create ci_drift_check --skip-empty` and fails if a new file appears. Any schema change must ship as a committed `src/migrations/*.ts` + `*.json` pair.
- German UI strings live in `src/messages/de.ts` (`as const`) — never hardcode German in a component.
- Models are **never committed**. They are downloaded with SHA-256 verification (build stage + `scripts/fetch-face-models.sh`), and `models/` is gitignored.
- **CI runs real WASM inference** — no stub, no mock. The `test` job gains a model-fetch step with `actions/cache`.
- **Test fixtures must be public domain.** This repository is public: no Verein member and no identifiable private person may be committed as a face fixture. Provenance is recorded in `tests/fixtures/README.md`.
- Access: `face-suggestions` is kurator/admin-only end to end; members must never see boxes, similarities or embeddings.

**Pinned model artefacts** (verified 2026-08-09 — both URLs returned HTTP 200 and these exact digests):

| File | Bytes | SHA-256 |
|---|---|---|
| `det_500m.onnx` | 2524817 | `5e4447f50245bbd7966bd6c0fa52938c61474a04ec7def48753668a9d8b4ea3a` |
| `w600k_mbf.onnx` | 13616099 | `9cc6e4a75f0e2bf0b1aed94578f144d15175f357bdc05e815e5c4a02b319eb4f` |

Base URL (pinned revision, **not** `main` — verified to yield the same digests):
`https://huggingface.co/deepghs/insightface/resolve/4e1f33d3fe0e50a0945f3a53ab94ae8977ae7ddb/buffalo_s/`

---

### Task 1: Pure face maths + model layer + model download + Dockerfile stage & probe

**Files:**
- Create: `src/lib/faces.ts`, `src/lib/face-model.ts`, `scripts/fetch-face-models.sh`, `scripts/probe-faces.mjs`
- Modify: `package.json` (dep + scripts), `next.config.ts`, `.gitignore`, `.env.example`, `Dockerfile`
- Test: `tests/unit/faces.test.ts`

**Interfaces (every later task consumes exactly these):**
- `src/lib/faces.ts` — `type Box = {xMin,yMin,xMax,yMax}` (pixels or 0…1 depending on caller), `type Detection = {box: Box; score: number; kps: [number,number][]}`, `l2Normalise`, `cosineSimilarity`, `roundEmbedding`, `normalizeBox`, `boxIoU`, `nms`, `similarityTransform`, `invertSimilarity`, `bestMatchPerPerson`, `ARCFACE_TEMPLATE_112`, `IOU_DUPLICATE_THRESHOLD`, `similarityThreshold()`, `detThreshold()`, `facesEnabled()`, `modelsDir()`.
- `src/lib/face-model.ts` — `analyseFaces(fileBuffer: Buffer): Promise<{width: number; height: number; faces: {box: Box; score: number; embedding: number[]}[]}>` and `modelsPresent(): boolean`. `box` is in **pixels of the decoded image**; `embedding` is L2-normalised and rounded.

- [ ] **Step 1: Add the dependency and the fetch script**

```sh
pnpm add onnxruntime-web@1.27.0
```

Create `scripts/fetch-face-models.sh` (make it executable: `chmod +x scripts/fetch-face-models.sh`):

```bash
#!/usr/bin/env bash
# Download the two InsightFace buffalo_s ONNX models used by src/lib/face-model.ts and verify
# their SHA-256. Never commit the models (see .gitignore) — 16 MB of binary that would live in
# this public repo's history forever. Used by: pnpm dev / pnpm test:int locally, the CI `test`
# job, and (via the same digests) the Dockerfile's model stage.
#   scripts/fetch-face-models.sh [target-dir]      default: ./models/faces
# Licence note: the InsightFace model zoo states "ALL models are available for non-commercial
# research purposes only." A Verein photo archive satisfies that; see docs/betrieb.md.
set -euo pipefail
target="${1:-models/faces}"
base="https://huggingface.co/deepghs/insightface/resolve/4e1f33d3fe0e50a0945f3a53ab94ae8977ae7ddb/buffalo_s"
# name:sha256 — pinned to the revision above, verified 2026-08-09
files=(
  "det_500m.onnx:5e4447f50245bbd7966bd6c0fa52938c61474a04ec7def48753668a9d8b4ea3a"
  "w600k_mbf.onnx:9cc6e4a75f0e2bf0b1aed94578f144d15175f357bdc05e815e5c4a02b319eb4f"
)
mkdir -p "$target"
for entry in "${files[@]}"; do
  name="${entry%%:*}"
  want="${entry##*:}"
  path="$target/$name"
  if [ -f "$path" ] && [ "$(sha256sum "$path" | cut -d' ' -f1)" = "$want" ]; then
    echo "ok (cached): $name"
    continue
  fi
  echo "downloading: $name"
  curl -fsSL --retry 3 -o "$path.tmp" "$base/$name"
  got="$(sha256sum "$path.tmp" | cut -d' ' -f1)"
  if [ "$got" != "$want" ]; then
    rm -f "$path.tmp"
    echo "SHA-256 mismatch for $name: expected $want, got $got" >&2
    exit 1
  fi
  mv "$path.tmp" "$path"
  echo "ok: $name"
done
```

> `sha256sum` is coreutils — present on Alpine, Debian and the GitHub runner. On macOS install coreutils (`brew install coreutils`) or substitute `shasum -a 256`; the script is only ever *run* on Linux in CI and the container, and locally on whatever the developer has.

Add to `package.json` `scripts`: `"faces:models": "scripts/fetch-face-models.sh"`, and prefix the int script so the models are always there:

```json
"test:int": "scripts/fetch-face-models.sh && cross-env DATABASE_URI=postgres://archiv:archiv@localhost:5433/archiv_test vitest run tests/int --no-file-parallelism",
```

Append to `.gitignore`:

```gitignore
# Face-recognition models — fetched with SHA-256 verification by scripts/fetch-face-models.sh,
# never committed (16 MB of binary, and this repo is public).
/models/
```

Append to `.env.example`:

```dotenv
# Face detection (P2.3). Set FACE_DETECTION_ENABLED=false to keep the code deployed but dormant.
# FACE_MODELS_DIR defaults to <cwd>/models/faces locally and /app/models/faces in the container.
FACE_DETECTION_ENABLED=true
FACE_MODELS_DIR=models/faces
FACE_SIMILARITY_THRESHOLD=0.40
FACE_DET_THRESHOLD=0.5
```

- [ ] **Step 2: Write the failing unit test**

Create `tests/unit/faces.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
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
} from '@/lib/faces'

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
```

- [ ] **Step 3: Run it — must fail** (`pnpm exec vitest run tests/unit/faces.test.ts`; expected: cannot resolve `@/lib/faces`)

- [ ] **Step 4: Implement `src/lib/faces.ts`**

```typescript
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
```

- [ ] **Step 5: Run the unit test — all must pass** (`pnpm exec vitest run tests/unit/faces.test.ts`)

- [ ] **Step 6: Inspect the models before writing the decoder** (one-off, do not skip)

The SCRFD decoder below assumes the standard InsightFace output layout: 9 outputs, ordered
`[score_8, score_16, score_32, bbox_8, bbox_16, bbox_32, kps_8, kps_16, kps_32]`, two anchors per
grid cell, bbox/kps in stride units. Confirm it against the actual files first:

```sh
pnpm faces:models
node --input-type=module -e "
import * as ort from 'onnxruntime-web';
ort.env.wasm.numThreads = 1;
for (const m of ['det_500m', 'w600k_mbf']) {
  const s = await ort.InferenceSession.create('models/faces/' + m + '.onnx');
  console.log(m, 'inputs', s.inputNames, 'outputs', s.outputNames);
}
"
```

Expected: both models report a single input named `input.1`; the detector reports 9 outputs. If
the count or ordering differs, adjust `decodeScrfd`'s indexing accordingly and note it in the file
comment — everything else in this plan is unaffected.

- [ ] **Step 7: Implement `src/lib/face-model.ts`**

```typescript
// ONNX inference layer: the only file that knows about onnxruntime, model tensor shapes and
// preprocessing constants. Everything above it (job, endpoints, page) sees plain boxes and
// number[] embeddings, so swapping the weights later is contained here.
//
// Runtime choice: `onnxruntime-web`, NOT `onnxruntime-node`. onnxruntime-node ships prebuilt
// native addons for exactly one Linux flavour and it is glibc (verified: the x64 binding needs
// libc.so.6/libstdc++.so.6 with versioned GLIBC_2.x symbols; the package contains no musl
// build), so it cannot load in our node:22-alpine image. onnxruntime-web has a first-class
// `node` condition in its exports map pointing at a purpose-built Node bundle that reads the
// SIMD .wasm off disk via node:fs — pure JS + WebAssembly, no libc linkage at all.
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import sharp from 'sharp'
import * as ort from 'onnxruntime-web'
import {
  type Box,
  type Detection,
  ARCFACE_TEMPLATE_112,
  applySimilarity,
  detThreshold,
  invertSimilarity,
  l2Normalise,
  modelsDir,
  nms,
  roundEmbedding,
  similarityTransform,
} from '@/lib/faces'

const DET_SIZE = 640 // detector input is a square letterbox of this side
const DET_MEAN = 127.5
const DET_STD = 128.0 // SCRFD's normalisation — note it differs from ArcFace's below
const REC_SIZE = 112
const REC_MEAN = 127.5
const REC_STD = 127.5
const STRIDES = [8, 16, 32]
const NUM_ANCHORS = 2
const NMS_IOU = 0.4

const require = createRequire(import.meta.url)

let configured = false
function configureOrt(): void {
  if (configured) return
  // Single-threaded on purpose: multi-threaded WASM spawns workers through emscripten's pthread
  // shim, which is exactly the sort of thing that misbehaves under Next's standalone output.
  // One photo takes well under a second either way, on a background queue. Raising this is a
  // one-line follow-up once someone has measured it.
  ort.env.wasm.numThreads = 1
  // Point the loader at the .wasm inside the installed package rather than relying on
  // resolution from whatever the process cwd happens to be. next.config.ts's
  // outputFileTracingIncludes is what guarantees these files survive `next build --standalone`.
  const dir = path.dirname(require.resolve('onnxruntime-web/package.json'))
  ort.env.wasm.wasmPaths = path.join(dir, 'dist') + path.sep
  configured = true
}

function modelPath(name: string): string {
  return path.resolve(modelsDir(), name)
}

export function modelsPresent(): boolean {
  return ['det_500m.onnx', 'w600k_mbf.onnx'].every((f) => fs.existsSync(modelPath(f)))
}

// One session per model per process, created lazily and shared by concurrent jobs. Holding the
// promise (not the resolved session) is what makes two simultaneous callers share a single load
// instead of racing two multi-megabyte initialisations.
let detSession: Promise<ort.InferenceSession> | null = null
let recSession: Promise<ort.InferenceSession> | null = null

function detector(): Promise<ort.InferenceSession> {
  configureOrt()
  detSession ??= ort.InferenceSession.create(modelPath('det_500m.onnx'))
  return detSession
}

function recogniser(): Promise<ort.InferenceSession> {
  configureOrt()
  recSession ??= ort.InferenceSession.create(modelPath('w600k_mbf.onnx'))
  return recSession
}

type Raw = { data: Buffer; width: number; height: number }

/** Decode to raw RGB once; both the detector and every crop sample from this same buffer. */
async function decodeRgb(fileBuffer: Buffer): Promise<Raw> {
  const { data, info } = await sharp(fileBuffer)
    .rotate() // honour EXIF orientation, else boxes land on a sideways image
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height }
}

/** Bilinear sample of one channel, with edge clamping. */
function sampleChannel(src: Raw, x: number, y: number, c: number): number {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = x - x0
  const fy = y - y0
  const cx = (v: number) => (v < 0 ? 0 : v > src.width - 1 ? src.width - 1 : v)
  const cy = (v: number) => (v < 0 ? 0 : v > src.height - 1 ? src.height - 1 : v)
  const at = (px: number, py: number) => src.data[(cy(py) * src.width + cx(px)) * 3 + c]
  const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx
  const bottom = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx
  return top * (1 - fy) + bottom * fy
}

/** Letterbox into a DET_SIZE square (top-left aligned, zero padded) as NCHW float. */
function letterbox(src: Raw): { tensor: Float32Array; scale: number } {
  const scale = Math.min(DET_SIZE / src.width, DET_SIZE / src.height)
  const outW = Math.round(src.width * scale)
  const outH = Math.round(src.height * scale)
  const plane = DET_SIZE * DET_SIZE
  const tensor = new Float32Array(3 * plane) // zero-filled = the padding
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const sx = x / scale
      const sy = y / scale
      for (let c = 0; c < 3; c++) {
        tensor[c * plane + y * DET_SIZE + x] = (sampleChannel(src, sx, sy, c) - DET_MEAN) / DET_STD
      }
    }
  }
  return { tensor, scale }
}

function outputData(map: ort.InferenceSession.OnnxValueMapType, name: string): Float32Array {
  const t = map[name]
  if (!t || !(t.data instanceof Float32Array)) {
    throw new Error(`face-model: output ${name} missing or not float32`)
  }
  return t.data
}

/**
 * SCRFD head decoding. Per stride there is one score row and one 4-value distance row per anchor,
 * distances being left/top/right/bottom from the anchor centre in stride units; the keypoint rows
 * are 5 (dx,dy) offsets from the same centre. Coordinates come out in letterboxed pixels and are
 * divided by `scale` to return to original-image pixels.
 */
function decodeScrfd(
  outputs: ort.InferenceSession.OnnxValueMapType,
  names: readonly string[],
  scale: number,
  threshold: number,
): Detection[] {
  const dets: Detection[] = []
  for (let i = 0; i < STRIDES.length; i++) {
    const stride = STRIDES[i]
    const scores = outputData(outputs, names[i])
    const bboxes = outputData(outputs, names[i + STRIDES.length])
    const kpss = outputData(outputs, names[i + STRIDES.length * 2])
    const grid = Math.ceil(DET_SIZE / stride)
    for (let idx = 0; idx < scores.length; idx++) {
      if (scores[idx] < threshold) continue
      const cell = Math.floor(idx / NUM_ANCHORS)
      const cx = (cell % grid) * stride
      const cy = Math.floor(cell / grid) * stride
      const b = idx * 4
      const box: Box = {
        xMin: (cx - bboxes[b] * stride) / scale,
        yMin: (cy - bboxes[b + 1] * stride) / scale,
        xMax: (cx + bboxes[b + 2] * stride) / scale,
        yMax: (cy + bboxes[b + 3] * stride) / scale,
      }
      const k = idx * 10
      const kps: [number, number][] = []
      for (let p = 0; p < 5; p++) {
        kps.push([
          (cx + kpss[k + p * 2] * stride) / scale,
          (cy + kpss[k + p * 2 + 1] * stride) / scale,
        ])
      }
      dets.push({ box, score: scores[idx], kps })
    }
  }
  return nms(dets, NMS_IOU)
}

/**
 * Warp the original image into a REC_SIZE square so the five keypoints land on
 * ARCFACE_TEMPLATE_112. This alignment is not cosmetic: ArcFace embeddings on a plain box crop
 * degrade badly and *silently*, which is why the int suite's acceptance test compares two photos
 * of the same person rather than merely asserting that a box was found. Backward mapping with
 * bilinear sampling, done in plain JS — 112x112 output pixels, deterministic, no libvips affine
 * semantics to get wrong.
 */
function alignedCrop(src: Raw, kps: [number, number][]): Float32Array {
  const forward = similarityTransform(kps, ARCFACE_TEMPLATE_112)
  const inverse = invertSimilarity(forward)
  const plane = REC_SIZE * REC_SIZE
  const tensor = new Float32Array(3 * plane)
  for (let y = 0; y < REC_SIZE; y++) {
    for (let x = 0; x < REC_SIZE; x++) {
      const [sx, sy] = applySimilarity(inverse, [x + 0.5, y + 0.5])
      for (let c = 0; c < 3; c++) {
        tensor[c * plane + y * REC_SIZE + x] =
          (sampleChannel(src, sx - 0.5, sy - 0.5, c) - REC_MEAN) / REC_STD
      }
    }
  }
  return tensor
}

export type AnalysedFace = { box: Box; score: number; embedding: number[] }

/**
 * Full pipeline for one image file: decode → detect → align+embed each face. Boxes come back in
 * pixels of the decoded (EXIF-rotated) image, alongside that image's dimensions, so the caller
 * can normalise them. Embeddings are L2-normalised and rounded, ready to store.
 */
export async function analyseFaces(
  fileBuffer: Buffer,
): Promise<{ width: number; height: number; faces: AnalysedFace[] }> {
  const src = await decodeRgb(fileBuffer)
  const det = await detector()
  const { tensor, scale } = letterbox(src)
  const detOut = await det.run({
    [det.inputNames[0]]: new ort.Tensor('float32', tensor, [1, 3, DET_SIZE, DET_SIZE]),
  })
  const detections = decodeScrfd(detOut, det.outputNames, scale, detThreshold())

  const rec = await recogniser()
  const faces: AnalysedFace[] = []
  for (const d of detections) {
    const crop = alignedCrop(src, d.kps)
    const recOut = await rec.run({
      [rec.inputNames[0]]: new ort.Tensor('float32', crop, [1, 3, REC_SIZE, REC_SIZE]),
    })
    const embedding = outputData(recOut, rec.outputNames[0])
    faces.push({ box: d.box, score: d.score, embedding: roundEmbedding(l2Normalise(embedding)) })
  }
  return { width: src.width, height: src.height, faces }
}
```

- [ ] **Step 8: Wire Next's bundler and file tracing** — in `next.config.ts`, add to `nextConfig`:

```typescript
  // onnxruntime-web must stay an external runtime require: bundling it breaks its Node entry's
  // node:fs based .wasm loading. The two tracing entries copy the SIMD wasm (and its glue .mjs)
  // into .next/standalone, which `next build` would otherwise skip — they are data files, not
  // imports, so nothing in the module graph points at them.
  serverExternalPackages: ['onnxruntime-web'],
  outputFileTracingIncludes: {
    '/**': [
      './node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm',
      './node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs',
    ],
  },
```

- [ ] **Step 9: Write the build probe `scripts/probe-faces.mjs`**

```javascript
// Build-time gate: actually run the whole face pipeline against a real photo with the exact
// models and wasm the container will use. Both silent-failure modes this guards against produce
// a GREEN build otherwise — a missing/untraced .wasm and a missing model directory both surface
// only as "no suggestions ever appear", weeks later. Same reasoning as the HEIC probe that
// already sits at the end of the Dockerfile's run stage.
import fs from 'node:fs'
import { analyseFaces } from './.next/standalone/face-probe-entry.mjs'

const file = process.argv[2]
const { width, height, faces } = await analyseFaces(fs.readFileSync(file))
if (faces.length < 1) {
  console.error(`face probe: no face found in ${file} (${width}x${height})`)
  process.exit(1)
}
const [first] = faces
if (first.embedding.length !== 512) {
  console.error(`face probe: expected a 512-d embedding, got ${first.embedding.length}`)
  process.exit(1)
}
console.log(`faces ok (${faces.length} face(s), score ${first.score.toFixed(3)})`)
```

> **Implementer note:** the import path above assumes a tiny entry file re-exporting `analyseFaces`
> from the standalone bundle. Simpler and preferred if it works in your build: run the probe with
> `node --experimental-strip-types` against `src/lib/face-model.ts` in the **build** stage (where
> `node_modules` and the TS sources are both present) rather than the run stage. Pick whichever of
> the two the image actually supports, keep the assertions identical, and record the choice in the
> Dockerfile comment. The requirement is only that a real inference runs during `docker build`.

- [ ] **Step 10: Dockerfile — model stage + probe**

Add a model stage **before** the `run` stage:

```dockerfile
# Face-recognition models (P2.3). Downloaded here rather than committed: 16 MB of binary that
# would otherwise live in this public repo's history forever. The SHA-256s in the script are what
# make this reproducible — a silently changed upstream file fails the build instead of quietly
# changing recognition behaviour. Licence: InsightFace's model zoo states these weights are for
# non-commercial research use only, which a Verein archive satisfies (see docs/betrieb.md).
FROM alpine:3.21 AS facemodels
RUN apk add --no-cache curl coreutils bash
WORKDIR /models
COPY scripts/fetch-face-models.sh .
RUN bash fetch-face-models.sh /models/faces
```

In the `run` stage, after the existing `COPY --from=build … ./public` lines:

```dockerfile
COPY --from=facemodels --chown=node:node /models/faces /app/models/faces
ENV FACE_MODELS_DIR=/app/models/faces
```

and after the existing HEIC probe, the face probe (using whichever invocation Step 9 settled on),
with a public-domain fixture:

```dockerfile
# Hard build-time gate on face inference actually working — same class of silent-fallback failure
# the HEIC probe above exists for. A missing .wasm, an untraced asset or an empty model directory
# all otherwise ship a green image whose only symptom is "no suggestions, ever".
COPY tests/fixtures/gesicht-a.jpg /tmp/face-probe.jpg
RUN node scripts/probe-faces.mjs /tmp/face-probe.jpg
RUN rm /tmp/face-probe.jpg
```

- [ ] **Step 11: Add the public-domain fixtures**

Three JPEGs in `tests/fixtures/`: `gesicht-a.jpg` and `gesicht-b.jpg` — two **different** photographs of the **same** person — and `gesicht-c.jpg`, a **different** person.

**Hard requirement: public domain, and not a Verein member or any identifiable private person — this repository is public.** Use NASA astronaut portraits from Wikimedia Commons: works of the U.S. federal government are public domain under 17 U.S.C. §105, Commons tags them `PD-USGov-NASA`, and many astronauts have several distinct official portraits (e.g. `Category:Official portrait photographs of NASA`). Pick faces that are large, front-facing and unobstructed — no EMU helmet on the pair used for the same-person assertion.

Create `tests/fixtures/README.md` recording, per file: the Commons file page URL, the licence tag, and what the fixture is for. Downscale each to ≤ 1600 px on the long edge (`sharp` or `magick`) so the repo does not gain multi-megabyte images.

- [ ] **Step 12: Verify** — `pnpm faces:models` succeeds and is idempotent (second run prints `ok (cached)`); the Step 6 inspection command still reports the expected shapes; `pnpm exec tsc --noEmit` clean; `pnpm lint` clean; `pnpm test:unit` green (existing + the new faces tests); `shellcheck scripts/*.sh` clean.

- [ ] **Step 13: Commit** — `feat: face model layer (onnxruntime-web WASM + buffalo_s), model fetch + build probe`

---

### Task 2: `face-suggestions` collection + migration

**Files:**
- Create: `src/collections/FaceSuggestions.ts`
- Modify: `src/payload.config.ts` (register the collection)
- Create: `src/migrations/<generated>_face_suggestions.ts` + `.json`
- Test: `tests/int/faces.int.test.ts` (new — access assertions only in this task)

**Interfaces:**
- Produces: collection slug `face-suggestions` with the fields listed below. Tasks 3–7 all read and write exactly these field names. `src/payload-types.ts` gains a `FaceSuggestion` type used by Tasks 5 and 6.

- [ ] **Step 1: Bring up the dev databases** (never the production compose file)

```sh
docker compose -f docker-compose.dev.yml up -d db db-test
```

The int suite additionally needs the app running against the **test** DB, in a second terminal:

```sh
DATABASE_URI=postgres://archiv:archiv@localhost:5433/archiv_test pnpm dev
```

- [ ] **Step 2: Implement `src/collections/FaceSuggestions.ts`**

```typescript
import type { CollectionConfig } from 'payload'
import { isKuratorOrAdmin } from '@/access/roles'

// P2.3 face detection. One row per detected face. The row is created by the detectFaces job with
// its embedding already computed, so confirming later performs no inference at all — it only
// flips `status` and tags the person.
//
// Access is kurator/admin at the collection level, and `embedding` is additionally unreadable by
// ANYONE through the API (access.read: () => false): no UI needs it, and a field no response can
// carry cannot leak through one. The job and the endpoints read it via overrideAccess.
export const FaceSuggestions: CollectionConfig = {
  slug: 'face-suggestions',
  labels: { singular: 'Gesichts-Vorschlag', plural: 'Gesichts-Vorschläge' },
  admin: { group: 'Archiv', defaultColumns: ['photo', 'suggestedPerson', 'status', 'similarity'] },
  access: {
    read: isKuratorOrAdmin,
    create: isKuratorOrAdmin,
    update: isKuratorOrAdmin,
    delete: isKuratorOrAdmin,
  },
  fields: [
    { name: 'photo', type: 'relationship', relationTo: 'photos', required: true, index: true, label: 'Foto' },
    // Normalised 0…1, not pixels: one row then crops correctly from thumbnail, web or original.
    { name: 'boxXMin', type: 'number', required: true },
    { name: 'boxYMin', type: 'number', required: true },
    { name: 'boxXMax', type: 'number', required: true },
    { name: 'boxYMax', type: 'number', required: true },
    { name: 'boxProbability', type: 'number', label: 'Erkennungssicherheit' },
    {
      name: 'embedding',
      type: 'json',
      label: 'Gesichtsmerkmal (biometrisch)',
      admin: { hidden: true },
      // Biometric data under Art. 9 DSGVO. Never leaves the server: no API response may carry
      // it, in either direction, for any role.
      access: { read: () => false, create: () => false, update: () => false },
    },
    { name: 'suggestedPerson', type: 'relationship', relationTo: 'people', index: true, label: 'Vorgeschlagene Person' },
    { name: 'similarity', type: 'number', label: 'Ähnlichkeit' },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'offen',
      index: true,
      label: 'Status',
      options: [
        { label: 'Offen', value: 'offen' },
        { label: 'Bestätigt', value: 'bestaetigt' },
        { label: 'Abgelehnt', value: 'abgelehnt' },
      ],
    },
    { name: 'confirmedBy', type: 'relationship', relationTo: 'users', admin: { readOnly: true }, label: 'Geprüft von' },
    { name: 'confirmedAt', type: 'date', admin: { readOnly: true }, label: 'Geprüft am' },
    { name: 'detectedAt', type: 'date', admin: { readOnly: true }, label: 'Erkannt am' },
    { name: 'sourceVariant', type: 'text', admin: { readOnly: true }, label: 'Quelle (Bildgröße)' },
  ],
}
```

- [ ] **Step 3: Register it** — in `src/payload.config.ts`, import `FaceSuggestions` and append it to the `collections` array (last, after `Photos`).

- [ ] **Step 4: Generate and commit the migration**

```sh
DATABASE_URI=postgres://archiv:archiv@localhost:5432/archiv pnpm payload migrate:create face_suggestions
```

Read the generated SQL. It must create `face_suggestions` with a `status` enum and FKs to
`photos`, `people` and `users`. **The `photos` FK must be `ON DELETE cascade`** — that is what
deletes a photo's face data with the photo (Task 6 depends on it, and it removes any need for a
capture hook). If the generator emitted `ON DELETE set null` for `photo_id`, edit the migration to
`cascade` and re-run it against a clean schema to confirm it applies. There must be **no**
`_face_suggestions_v` table (no drafts) and **no** new `_photos_v` columns (no field was added to
`photos`).

- [ ] **Step 5: Regenerate types** — `pnpm generate:types`, then confirm `src/payload-types.ts` contains `FaceSuggestion` and commit it.

- [ ] **Step 6: Drift check must be clean** (exactly what CI runs):

```sh
docker compose -f docker-compose.dev.yml exec -T db-test psql -U archiv -d archiv_test \
  -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
DATABASE_URI=postgres://archiv:archiv@localhost:5433/archiv_test pnpm payload migrate
DATABASE_URI=postgres://archiv:archiv@localhost:5433/archiv_test pnpm payload migrate:create drift_check --skip-empty
git status --porcelain src/migrations/   # must show nothing new
```

- [ ] **Step 7: Write the access int test** — create `tests/int/faces.int.test.ts`:

```typescript
// Integration: P2.3 face detection. Runs the REAL models (scripts/fetch-face-models.sh runs as
// part of `pnpm test:int`) — there is no stub. The HTTP blocks need the dev server running
// against the TEST database, same setup as invites.int.test.ts.
import { describe, it, expect, beforeAll } from 'vitest'
import { getPayload, type Payload } from 'payload'
import config from '@payload-config'

let payload: Payload
const password = 'geheim123'
let memberEmail: string
let kuratorEmail: string

beforeAll(async () => {
  payload = await getPayload({ config: await config })
  const stamp = Date.now()
  memberEmail = `face-m${stamp}@example.com`
  kuratorEmail = `face-k${stamp}@example.com`
  await payload.create({
    collection: 'users',
    data: { name: 'Face Mitglied', email: memberEmail, password, role: 'mitglied' },
    overrideAccess: true,
  })
  await payload.create({
    collection: 'users',
    data: { name: 'Face Kurator', email: kuratorEmail, password, role: 'kurator' },
    overrideAccess: true,
  })
})

export async function loginCookie(email: string): Promise<string> {
  const res = await fetch('http://localhost:3000/api/users/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  expect(res.ok).toBe(true)
  return res.headers.get('set-cookie') ?? ''
}

describe('face-suggestions access', () => {
  it('a mitglied cannot list face suggestions', async () => {
    const cookie = await loginCookie(memberEmail)
    const res = await fetch('http://localhost:3000/api/face-suggestions', { headers: { cookie } })
    expect(res.status).toBe(403)
  })

  it('a kurator can list them', async () => {
    const cookie = await loginCookie(kuratorEmail)
    const res = await fetch('http://localhost:3000/api/face-suggestions', { headers: { cookie } })
    expect(res.status).toBe(200)
  })

  it('the embedding never appears in an API response, even for a kurator', async () => {
    const photo = await payload.create({
      collection: 'photos',
      data: { caption: 'Zugriffstest', datePrecision: 'unknown', _status: 'published' },
      filePath: 'tests/fixtures/gesicht-a.jpg',
      overrideAccess: true,
    })
    await payload.create({
      collection: 'face-suggestions',
      data: {
        photo: photo.id,
        boxXMin: 0.1, boxYMin: 0.1, boxXMax: 0.4, boxYMax: 0.4,
        embedding: [0.1, 0.2, 0.3],
        status: 'offen',
      },
      overrideAccess: true,
    })
    const cookie = await loginCookie(kuratorEmail)
    const res = await fetch(`http://localhost:3000/api/face-suggestions?where[photo][equals]=${photo.id}`, {
      headers: { cookie },
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { docs: Record<string, unknown>[] }
    expect(json.docs.length).toBe(1)
    expect(json.docs[0].embedding).toBeUndefined()
  })
})
```

- [ ] **Step 8: Full local gate + commit** — `feat: face-suggestions collection with server-only embedding field`

---

### Task 3: Detection job + publish-transition enqueue + `faces` queue

**Files:**
- Create: `src/jobs/detectFaces.ts`
- Modify: `src/collections/Photos.ts` (new `afterChange` hook), `src/payload.config.ts` (task + autoRun)
- Test: extend `tests/int/faces.int.test.ts`

**Interfaces:**
- Consumes: `analyseFaces`, `modelsPresent` (Task 1), the `face-suggestions` fields (Task 2).
- Produces: task slug `detectFaces`, input `{ photoId: string | number }`, output `{ suggestionCount: number }`; queue name `faces`. Task 4 extends the same handler; Task 7 enqueues it in bulk.

- [ ] **Step 1: Implement `src/jobs/detectFaces.ts`**

```typescript
// P2.3: detect faces on a published photo and store one face-suggestions row per face, with the
// embedding computed up front. Runs as a job, not inline in the publish request, because
// inference is hundreds of milliseconds of WASM rather than the few milliseconds applyPhash
// costs. Its own `faces` queue keeps a slow face job from starving the daily Papierkorb purge.
import fs from 'node:fs/promises'
import path from 'node:path'
import type { TaskConfig, TaskHandler, PayloadRequest } from 'payload'
import { analyseFaces, modelsPresent } from '@/lib/face-model'
import { boxIoU, facesEnabled, IOU_DUPLICATE_THRESHOLD, normalizeBox, type Box } from '@/lib/faces'

type DetectFacesIO = {
  input: { photoId: string | number }
  output: { suggestionCount: number }
}

type PhotoLike = {
  id: string | number
  filename?: string | null
  _status?: string | null
  deletedAt?: string | null
  hasHiddenPerson?: boolean | null
  sizes?: { web?: { filename?: string | null } | null } | null
}

/**
 * Photos has no `upload.staticDir` override, so Payload uses its default — the collection slug
 * resolved against process.cwd(), i.e. <cwd>/photos (and /app/photos in the container, which is
 * exactly what docker-compose.yml's `uploads` volume mounts; see the comment there).
 *
 * Prefer the 1600px `web` variant: it is plenty for a 640px detector input and much cheaper to
 * decode than a 40-megapixel scan. Payload skips generating a size larger than the source, so
 * fall back to the original when `web` is absent.
 */
function resolveFile(photo: PhotoLike): { file: string; variant: 'web' | 'original' } | null {
  const dir = path.resolve(process.cwd(), 'photos')
  const web = photo.sizes?.web?.filename
  if (web) return { file: path.join(dir, web), variant: 'web' }
  if (photo.filename) return { file: path.join(dir, photo.filename), variant: 'original' }
  return null
}

export const detectFacesHandler: TaskHandler<DetectFacesIO> = async ({ input, req }) => {
  const photo = (await req.payload.findByID({
    collection: 'photos',
    id: input.photoId,
    overrideAccess: true,
    disableErrors: true,
    depth: 0,
    req,
  })) as PhotoLike | null

  // Re-check every guard: the photo may have been unpublished, binned or had a hidden person
  // added between the enqueue and this run.
  if (!photo) return { output: { suggestionCount: 0 } }
  if (!facesEnabled() || !modelsPresent()) return { output: { suggestionCount: 0 } }
  if (photo._status !== 'published' || photo.deletedAt || photo.hasHiddenPerson) {
    return { output: { suggestionCount: 0 } }
  }
  const resolved = resolveFile(photo)
  if (!resolved) return { output: { suggestionCount: 0 } }

  const buffer = await fs.readFile(resolved.file)
  const { width, height, faces } = await analyseFaces(buffer)

  // Idempotency: drop this photo's still-open rows, then skip any new box that lands on a face a
  // kurator already decided about, so a re-run can never resurrect a rejected face.
  await req.payload.delete({
    collection: 'face-suggestions',
    where: { and: [{ photo: { equals: photo.id } }, { status: { equals: 'offen' } }] },
    overrideAccess: true,
    req,
  })
  const decided = await req.payload.find({
    collection: 'face-suggestions',
    where: { and: [{ photo: { equals: photo.id } }, { status: { not_equals: 'offen' } }] },
    limit: 0,
    pagination: false,
    overrideAccess: true,
    depth: 0,
    req,
  })
  const decidedBoxes: Box[] = decided.docs.map((d) => ({
    xMin: d.boxXMin, yMin: d.boxYMin, xMax: d.boxXMax, yMax: d.boxYMax,
  }))

  let suggestionCount = 0
  for (const face of faces) {
    const box = normalizeBox(face.box, width, height)
    if (decidedBoxes.some((b) => boxIoU(b, box) > IOU_DUPLICATE_THRESHOLD)) continue
    await req.payload.create({
      collection: 'face-suggestions',
      data: {
        photo: photo.id,
        boxXMin: box.xMin, boxYMin: box.yMin, boxXMax: box.xMax, boxYMax: box.yMax,
        boxProbability: face.score,
        embedding: face.embedding,
        status: 'offen',
        detectedAt: new Date().toISOString(),
        sourceVariant: resolved.variant,
      },
      overrideAccess: true,
      req,
    })
    suggestionCount++
  }

  req.payload.logger.info({ msg: 'face-detect', photoId: photo.id, detected: faces.length, suggestionCount })
  return { output: { suggestionCount } }
}

export const detectFacesTask: TaskConfig<DetectFacesIO> = {
  slug: 'detectFaces',
  label: 'Gesichter erkennen',
  handler: detectFacesHandler,
  // Two attempts, not three: there is no network in this path, so a second failure is a bug or a
  // missing model — retrying a third time fixes neither.
  retries: { attempts: 2, backoff: { type: 'exponential', delay: 30_000 } },
}

/** Shared by the publish hook and the backfill task so the eligibility rule exists exactly once. */
export async function enqueueDetectFaces(req: PayloadRequest, photoId: string | number): Promise<void> {
  await req.payload.jobs.queue({ task: 'detectFaces', input: { photoId }, queue: 'faces', req })
}
```

- [ ] **Step 2: Enqueue on the publish transition** — in `src/collections/Photos.ts`, import the helper and add an `afterChange` array to `hooks` (Photos currently has none):

```typescript
    // P2.3: face detection runs on the draft→published transition, never on a draft. Member
    // uploads land as drafts and a kurator may delete them unpublished; computing and STORING
    // biometric templates for photos that get thrown away is processing we can simply not do.
    // Also covers a replaced file on an already-published photo. Never throws: a failed enqueue
    // must not fail the publish.
    afterChange: [
      async ({ doc, previousDoc, req, operation }) => {
        if (!facesEnabled()) return
        const nowPublished = doc._status === 'published'
        const wasPublished = operation === 'update' && previousDoc?._status === 'published'
        const fileChanged = wasPublished && doc.filename !== previousDoc?.filename
        if (!nowPublished || (wasPublished && !fileChanged)) return
        if (doc.hasHiddenPerson || doc.deletedAt) return
        try {
          await enqueueDetectFaces(req, doc.id)
        } catch (err) {
          req.payload.logger.error({
            msg: 'face-detect-enqueue-failed',
            photoId: doc.id,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      },
    ],
```

- [ ] **Step 3: Register the task and its runner** — in `src/payload.config.ts`:
  - import `detectFacesTask` and add it to `jobs.tasks`;
  - extend `autoRun` to:

```typescript
    // The `faces` queue runs every minute (suggestions should appear while the kurator is still
    // at the screen) but with a `limit`, so the one-off full backfill drains at a fixed,
    // self-throttling rate instead of saturating the box.
    autoRun: [
      { cron: '*/15 * * * *', queue: 'default' },
      { cron: '* * * * *', queue: 'faces', limit: 10 },
    ],
```

> If `AutorunCronConfig` in payload 3.87 does not accept `limit`, drop it and instead cap the
> backfill's enqueue batch in Task 7. Check `node_modules/payload/dist/queues/config/types/index.d.ts`.

- [ ] **Step 4: Extend the int test** — append to `tests/int/faces.int.test.ts`:

```typescript
import { l2Normalise } from '@/lib/faces'

async function runFacesQueue(): Promise<void> {
  await payload.jobs.run({ queue: 'faces', overrideAccess: true })
}

async function suggestionsFor(photoId: string | number) {
  const res = await payload.find({
    collection: 'face-suggestions',
    where: { photo: { equals: photoId } },
    overrideAccess: true,
    pagination: false,
    depth: 0,
  })
  return res.docs
}

describe('detection runs on publish, not on draft', () => {
  it('creates no suggestions for a draft', async () => {
    const photo = await payload.create({
      collection: 'photos',
      data: { caption: 'Entwurf', datePrecision: 'unknown', _status: 'draft' },
      filePath: 'tests/fixtures/gesicht-a.jpg',
      overrideAccess: true,
    })
    await runFacesQueue()
    expect(await suggestionsFor(photo.id)).toHaveLength(0)
  })

  it('creates a suggestion with a 512-d embedding when the photo is published', async () => {
    const photo = await payload.create({
      collection: 'photos',
      data: { caption: 'Veröffentlicht', datePrecision: 'unknown', _status: 'published' },
      filePath: 'tests/fixtures/gesicht-a.jpg',
      overrideAccess: true,
    })
    await runFacesQueue()
    const docs = await suggestionsFor(photo.id)
    expect(docs.length).toBeGreaterThanOrEqual(1)
    const [s] = docs
    expect(s.status).toBe('offen')
    expect(Array.isArray(s.embedding)).toBe(true)
    expect((s.embedding as number[]).length).toBe(512)
    for (const v of [s.boxXMin, s.boxYMin, s.boxXMax, s.boxYMax]) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
    expect(s.boxXMax).toBeGreaterThan(s.boxXMin)
  })
})

// THE acceptance test for keypoint alignment. A plain box crop instead of the 5-point ArcFace
// alignment still produces plausible-looking 512-d vectors — it just makes them useless for
// matching. Nothing else in this suite would catch that; this does.
describe('embeddings identify the same person across photos', () => {
  it('scores same-person higher than different-person, and clears the default threshold', async () => {
    const mk = async (fixture: string) => {
      const photo = await payload.create({
        collection: 'photos',
        data: { caption: fixture, datePrecision: 'unknown', _status: 'published' },
        filePath: `tests/fixtures/${fixture}`,
        overrideAccess: true,
      })
      await runFacesQueue()
      const docs = await suggestionsFor(photo.id)
      expect(docs.length).toBeGreaterThanOrEqual(1)
      const biggest = docs.sort(
        (x, y) => (y.boxXMax - y.boxXMin) * (y.boxYMax - y.boxYMin) - (x.boxXMax - x.boxXMin) * (x.boxYMax - x.boxYMin),
      )[0]
      return l2Normalise(biggest.embedding as number[])
    }
    const a = await mk('gesicht-a.jpg')
    const b = await mk('gesicht-b.jpg')
    const c = await mk('gesicht-c.jpg')
    const same = a.reduce((acc, v, i) => acc + v * b[i], 0)
    const different = a.reduce((acc, v, i) => acc + v * c[i], 0)
    expect(same).toBeGreaterThan(different)
    expect(same).toBeGreaterThan(0.4)
  })
})
```

- [ ] **Step 5: Full local gate + commit** — `feat: detectFaces job on the publish transition, own faces queue`

---

### Task 4: Matching — turn detections into named suggestions

**Files:**
- Modify: `src/jobs/detectFaces.ts`
- Test: extend `tests/int/faces.int.test.ts`

**Interfaces:**
- Consumes: `bestMatchPerPerson`, `similarityThreshold` (Task 1).
- Produces: rows now carry `suggestedPerson` + `similarity` when a confirmed face of that person scores above the threshold. Task 5's UI pre-selects the dropdown from these.

- [ ] **Step 1: Load the index and match** — in `detectFacesHandler`, after computing `faces` and before the create loop:

```typescript
  // The face index is derived, not stored separately: it is exactly the confirmed rows that
  // still hold an embedding and name a person. `depth: 0` keeps the relationship as a bare id.
  const confirmed = await req.payload.find({
    collection: 'face-suggestions',
    where: {
      and: [
        { status: { equals: 'bestaetigt' } },
        { suggestedPerson: { exists: true } },
        { embedding: { exists: true } },
      ],
    },
    limit: 0,
    pagination: false,
    overrideAccess: true,
    depth: 0,
    req,
  })
  // Never index a person whose consent is withdrawn — belt and braces next to the purge hook.
  const hiddenIds = new Set(
    (
      await req.payload.find({
        collection: 'people',
        where: { hidden: { equals: true } },
        limit: 0, pagination: false, overrideAccess: true, depth: 0, req,
      })
    ).docs.map((p) => String(p.id)),
  )
  const index: IndexedFace[] = confirmed.docs
    .filter((d) => d.suggestedPerson != null && !hiddenIds.has(String(d.suggestedPerson)))
    .map((d) => ({ personId: d.suggestedPerson as number | string, embedding: d.embedding as number[] }))
  const threshold = similarityThreshold()
```

and inside the create loop, before `req.payload.create`:

```typescript
    const match = bestMatchPerPerson(face.embedding, index, threshold)
```

then add to the created `data`:

```typescript
        suggestedPerson: match?.personId ?? null,
        similarity: match?.similarity ?? null,
```

Update the imports from `@/lib/faces` to include `bestMatchPerPerson`, `similarityThreshold` and
`type IndexedFace`.

- [ ] **Step 2: Extend the int test**

```typescript
describe('matching against confirmed faces', () => {
  it('suggests the person on a second photo once the first is confirmed', async () => {
    const person = await payload.create({
      collection: 'people',
      data: { name: `Testperson ${Date.now()}` },
      overrideAccess: true,
    })
    const first = await payload.create({
      collection: 'photos',
      data: { caption: 'erstes', datePrecision: 'unknown', _status: 'published' },
      filePath: 'tests/fixtures/gesicht-a.jpg',
      overrideAccess: true,
    })
    await runFacesQueue()
    const [firstRow] = await suggestionsFor(first.id)
    // No index yet, so nothing can be suggested on the very first photo of a person.
    expect(firstRow.suggestedPerson).toBeFalsy()

    await payload.update({
      collection: 'face-suggestions',
      id: firstRow.id,
      data: { status: 'bestaetigt', suggestedPerson: person.id },
      overrideAccess: true,
    })

    const second = await payload.create({
      collection: 'photos',
      data: { caption: 'zweites', datePrecision: 'unknown', _status: 'published' },
      filePath: 'tests/fixtures/gesicht-b.jpg',
      overrideAccess: true,
    })
    await runFacesQueue()
    const rows = await suggestionsFor(second.id)
    const matched = rows.find((r) => String(r.suggestedPerson) === String(person.id))
    expect(matched).toBeDefined()
    expect(matched!.similarity).toBeGreaterThan(0.4)
  })
})
```

- [ ] **Step 3: Full local gate + commit** — `feat: match detected faces against confirmed embeddings (cosine)`

---

### Task 5: `/gesichter` kurator page + confirm/reject/undo endpoints + German strings

**Files:**
- Create: `src/app/(frontend)/gesichter/page.tsx`, `src/app/(frontend)/gesichter/FaceReviewForm.tsx`
- Modify: `src/collections/FaceSuggestions.ts` (endpoints), `src/messages/de.ts`, `src/app/(frontend)/layout.tsx` (nav link)
- Test: extend `tests/int/faces.int.test.ts`

**Interfaces:**
- Produces: `POST /api/face-suggestions/:id/bestaetigen` (body `{personId}`), `.../ablehnen`, `.../zuruecksetzen`. All return `{ok: true}` on success or `{error: string}` with 400/403/404/409.

- [ ] **Step 1: German strings** — add to `src/messages/de.ts` before the closing `} as const`:

```typescript
  gesichter: {
    title: 'Gesichter prüfen',
    hint: 'Wer ist das? Bestätigte Gesichter helfen dabei, dieselbe Person auf weiteren Fotos vorzuschlagen.',
    empty: 'Keine offenen Vorschläge.',
    disabled: 'Gesichtserkennung ist nicht aktiviert.',
    person: 'Person',
    choose: '(unbekannt)',
    similarity: 'Ähnlichkeit',
    confirm: 'Bestätigen',
    reject: 'Ablehnen',
    undo: 'Rückgängig',
    saving: 'speichert',
    error: 'Das hat nicht geklappt — bitte erneut versuchen.',
    needsPerson: 'Bitte zuerst eine Person auswählen.',
  },
```

- [ ] **Step 2: The three endpoints** — add an `endpoints` array to `FaceSuggestions` (same idiom as `Invites`' `/accept`):

```typescript
  endpoints: [
    {
      path: '/:id/bestaetigen',
      method: 'post',
      handler: async (req) => {
        if (!isModerator(req)) return Response.json({ error: 'Nicht erlaubt' }, { status: 403 })
        const id = req.routeParams?.id as string
        const { personId } = (await req.json?.()) ?? {}
        if (!personId) return Response.json({ error: 'Person fehlt' }, { status: 400 })

        const suggestion = await req.payload
          .findByID({ collection: 'face-suggestions', id, overrideAccess: true, depth: 0, req })
          .catch(() => null)
        if (!suggestion) return Response.json({ error: 'Nicht gefunden' }, { status: 404 })

        const person = await req.payload
          .findByID({ collection: 'people', id: personId, overrideAccess: true, depth: 0, req })
          .catch(() => null)
        if (!person) return Response.json({ error: 'Person nicht gefunden' }, { status: 404 })
        // A person whose consent is withdrawn can never be re-indexed through this path.
        if (person.hidden) {
          return Response.json({ error: 'Diese Person ist verborgen.' }, { status: 409 })
        }

        await req.payload.update({
          collection: 'face-suggestions',
          id,
          data: {
            status: 'bestaetigt',
            suggestedPerson: personId,
            confirmedBy: req.user?.id ?? null,
            confirmedAt: new Date().toISOString(),
          },
          overrideAccess: true,
          req,
        })
        await addPersonToPhoto(req, suggestion.photo as string | number, personId)
        return Response.json({ ok: true })
      },
    },
    {
      path: '/:id/ablehnen',
      method: 'post',
      handler: async (req) => {
        if (!isModerator(req)) return Response.json({ error: 'Nicht erlaubt' }, { status: 403 })
        const id = req.routeParams?.id as string
        await req.payload.update({
          collection: 'face-suggestions',
          id,
          // Rejected means "not a face" or "not identifiable" — we do not train on negatives, so
          // the biometric payload goes immediately. The row survives only as a tombstone, so a
          // re-run's IoU check cannot resurrect the same box.
          data: {
            status: 'abgelehnt',
            embedding: null,
            confirmedBy: req.user?.id ?? null,
            confirmedAt: new Date().toISOString(),
          },
          overrideAccess: true,
          req,
        })
        return Response.json({ ok: true })
      },
    },
    {
      path: '/:id/zuruecksetzen',
      method: 'post',
      handler: async (req) => {
        if (!isModerator(req)) return Response.json({ error: 'Nicht erlaubt' }, { status: 403 })
        const id = req.routeParams?.id as string
        const suggestion = await req.payload
          .findByID({ collection: 'face-suggestions', id, overrideAccess: true, depth: 0, req })
          .catch(() => null)
        if (!suggestion) return Response.json({ error: 'Nicht gefunden' }, { status: 404 })
        if (suggestion.suggestedPerson) {
          await removePersonFromPhoto(
            req,
            suggestion.photo as string | number,
            suggestion.suggestedPerson as string | number,
          )
        }
        await req.payload.update({
          collection: 'face-suggestions',
          id,
          // The embedding stays: it is still a valid face, it is just no longer indexed to anyone
          // (the index is "confirmed AND names a person").
          data: { status: 'offen', confirmedBy: null, confirmedAt: null },
          overrideAccess: true,
          req,
        })
        return Response.json({ ok: true })
      },
    },
  ],
```

with these helpers at the top of the same file:

```typescript
import type { PayloadRequest } from 'payload'

const isModerator = (req: PayloadRequest): boolean =>
  req.user?.role === 'admin' || req.user?.role === 'kurator'

// Tagging goes through payload.update with the same `req`, so Photos' existing beforeChange hook
// recomputes hasHiddenPerson in the same transaction — no hidden-person logic is duplicated here.
async function addPersonToPhoto(req: PayloadRequest, photoId: string | number, personId: string | number) {
  const photo = await req.payload.findByID({
    collection: 'photos', id: photoId, overrideAccess: true, depth: 0, req,
  })
  const current = ((photo.people ?? []) as (string | number)[]).map(String)
  if (current.includes(String(personId))) return
  await req.payload.update({
    collection: 'photos',
    id: photoId,
    data: { people: [...current, String(personId)] },
    overrideAccess: true,
    depth: 0,
    req,
  })
}

async function removePersonFromPhoto(req: PayloadRequest, photoId: string | number, personId: string | number) {
  const photo = await req.payload.findByID({
    collection: 'photos', id: photoId, overrideAccess: true, depth: 0, req,
  })
  const current = ((photo.people ?? []) as (string | number)[]).map(String)
  const next = current.filter((p) => p !== String(personId))
  if (next.length === current.length) return
  await req.payload.update({
    collection: 'photos', id: photoId, data: { people: next }, overrideAccess: true, depth: 0, req,
  })
}
```

> **Implementer note:** confirm how 3.87 exposes path params in a custom endpoint handler
> (`req.routeParams` is expected). If the shape differs, adapt — the three paths and their
> semantics are what matter.

- [ ] **Step 3: The page** — `src/app/(frontend)/gesichter/page.tsx`:

```tsx
import { getPayload } from 'payload'
import config from '@payload-config'
import { notFound, redirect } from 'next/navigation'
import { getUser } from '@/lib/get-user'
import { de } from '@/messages/de'
import { facesEnabled } from '@/lib/faces'
import { FaceReviewForm } from './FaceReviewForm'

export const dynamic = 'force-dynamic'

export default async function GesichterPage() {
  const user = await getUser()
  if (!user) redirect('/anmelden')
  // notFound() rather than a 403, matching how personen/[id] hides a hidden person from members.
  if (user.role !== 'admin' && user.role !== 'kurator') notFound()

  if (!facesEnabled()) {
    return (
      <>
        <h1>{de.gesichter.title}</h1>
        <p>{de.gesichter.disabled}</p>
      </>
    )
  }

  const payload = await getPayload({ config })
  const [suggestions, people] = await Promise.all([
    payload.find({
      collection: 'face-suggestions',
      where: { status: { equals: 'offen' } },
      sort: '-detectedAt',
      limit: 30,
      depth: 1,
      overrideAccess: false,
      user,
    }),
    payload.find({
      collection: 'people',
      where: { hidden: { not_equals: true } },
      sort: 'name',
      pagination: false,
      overrideAccess: false,
      user,
    }),
  ])

  // Suggestions whose photo is in the Papierkorb are not reviewable: the bin is reversible, so
  // the rows stay put and simply drop out of the queue until the photo is restored or purged.
  const open = suggestions.docs.filter(
    (s) => typeof s.photo === 'object' && s.photo !== null && !s.photo.deletedAt,
  )

  return (
    <>
      <h1>{de.gesichter.title}</h1>
      <p>{de.gesichter.hint}</p>
      {open.length === 0 && <p>{de.gesichter.empty}</p>}
      <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: '1rem' }}>
        {open.map((s) => {
          const photo = s.photo as { id: string | number; caption?: string | null; sizes?: { thumbnail?: { url?: string | null; width?: number | null } | null } | null }
          const thumb = photo.sizes?.thumbnail
          const boxW = Math.max(s.boxXMax - s.boxXMin, 0.01)
          const boxH = Math.max(s.boxYMax - s.boxYMin, 0.01)
          // Crop by CSS from the existing thumbnail — no face crops are ever written to disk.
          // The 96px viewport shows the box; the image is scaled so the box fills it and shifted
          // so the box's top-left lands at the viewport's origin.
          const VIEW = 96
          const scaledW = VIEW / boxW
          const scaledH = VIEW / boxH
          return (
            <li key={s.id} style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
              <div style={{ width: VIEW, height: VIEW, overflow: 'hidden', position: 'relative', flex: '0 0 auto', background: '#222' }}>
                {thumb?.url && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={thumb.url}
                    alt=""
                    style={{
                      position: 'absolute',
                      width: scaledW,
                      height: scaledH,
                      left: -s.boxXMin * scaledW,
                      top: -s.boxYMin * scaledH,
                      maxWidth: 'none',
                    }}
                  />
                )}
              </div>
              <div style={{ flex: 1 }}>
                <div>{photo.caption ?? ''}</div>
                {typeof s.similarity === 'number' && (
                  <div style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>
                    {de.gesichter.similarity}: {(s.similarity * 100).toFixed(0)} %
                  </div>
                )}
                <FaceReviewForm
                  suggestionId={String(s.id)}
                  defaultPersonId={s.suggestedPerson ? String(typeof s.suggestedPerson === 'object' ? s.suggestedPerson.id : s.suggestedPerson) : ''}
                  people={people.docs.map((p) => ({ id: String(p.id), name: p.name }))}
                />
              </div>
            </li>
          )
        })}
      </ul>
    </>
  )
}
```

- [ ] **Step 4: The client form** — `src/app/(frontend)/gesichter/FaceReviewForm.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { de } from '@/messages/de'

type Props = {
  suggestionId: string
  defaultPersonId: string
  people: { id: string; name: string }[]
}

export function FaceReviewForm({ suggestionId, defaultPersonId, people }: Props) {
  const router = useRouter()
  const [personId, setPersonId] = useState(defaultPersonId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function act(action: 'bestaetigen' | 'ablehnen') {
    if (busy) return // re-entrancy guard, same as UploadForm's
    if (action === 'bestaetigen' && !personId) {
      setError(de.gesichter.needsPerson)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/face-suggestions/${suggestionId}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action === 'bestaetigen' ? { personId } : {}),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        setError(body?.error ?? de.gesichter.error)
        return
      }
      router.refresh()
    } catch {
      setError(de.gesichter.error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.5rem', flexWrap: 'wrap' }}>
      <label>
        {de.gesichter.person}{' '}
        <select value={personId} onChange={(e) => setPersonId(e.target.value)} disabled={busy}>
          <option value="">{de.gesichter.choose}</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </label>
      <button type="button" onClick={() => act('bestaetigen')} disabled={busy}>
        {busy ? de.gesichter.saving : de.gesichter.confirm}
      </button>
      <button type="button" onClick={() => act('ablehnen')} disabled={busy}>
        {de.gesichter.reject}
      </button>
      {error && <span role="alert">{error}</span>}
    </div>
  )
}
```

- [ ] **Step 5: Nav link** — in `src/app/(frontend)/layout.tsx`, render a link to `/gesichter` **only** for `admin`/`kurator`, using a new `de.nav.gesichter` string (add `gesichter: 'Gesichter'` to `de.nav`). Match the existing nav markup exactly.

- [ ] **Step 6: Extend the int test**

```typescript
describe('confirm / reject / undo', () => {
  it('a mitglied is refused on all three endpoints', async () => {
    const cookie = await loginCookie(memberEmail)
    for (const action of ['bestaetigen', 'ablehnen', 'zuruecksetzen']) {
      const res = await fetch(`http://localhost:3000/api/face-suggestions/1/${action}`, {
        method: 'POST',
        headers: { cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ personId: 1 }),
      })
      expect(res.status).toBe(403)
    }
  })

  it('confirming tags the person on the photo; undoing removes the tag again', async () => {
    const person = await payload.create({
      collection: 'people', data: { name: `Bestätigt ${Date.now()}` }, overrideAccess: true,
    })
    const photo = await payload.create({
      collection: 'photos',
      data: { caption: 'bestätigen', datePrecision: 'unknown', _status: 'published' },
      filePath: 'tests/fixtures/gesicht-a.jpg',
      overrideAccess: true,
    })
    await runFacesQueue()
    const [row] = await suggestionsFor(photo.id)
    const cookie = await loginCookie(kuratorEmail)

    const ok = await fetch(`http://localhost:3000/api/face-suggestions/${row.id}/bestaetigen`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ personId: person.id }),
    })
    expect(ok.status).toBe(200)
    let after = await payload.findByID({ collection: 'photos', id: photo.id, overrideAccess: true, depth: 0 })
    expect((after.people ?? []).map(String)).toContain(String(person.id))

    const undo = await fetch(`http://localhost:3000/api/face-suggestions/${row.id}/zuruecksetzen`, {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: '{}',
    })
    expect(undo.status).toBe(200)
    after = await payload.findByID({ collection: 'photos', id: photo.id, overrideAccess: true, depth: 0 })
    expect((after.people ?? []).map(String)).not.toContain(String(person.id))
  })

  it('rejecting deletes the embedding', async () => {
    const photo = await payload.create({
      collection: 'photos',
      data: { caption: 'ablehnen', datePrecision: 'unknown', _status: 'published' },
      filePath: 'tests/fixtures/gesicht-c.jpg',
      overrideAccess: true,
    })
    await runFacesQueue()
    const [row] = await suggestionsFor(photo.id)
    const cookie = await loginCookie(kuratorEmail)
    const res = await fetch(`http://localhost:3000/api/face-suggestions/${row.id}/ablehnen`, {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: '{}',
    })
    expect(res.status).toBe(200)
    const reloaded = await payload.findByID({
      collection: 'face-suggestions', id: row.id, overrideAccess: true, depth: 0,
    })
    expect(reloaded.status).toBe('abgelehnt')
    expect(reloaded.embedding).toBeFalsy()
  })

  it('confirming a hidden person is refused with 409', async () => {
    const person = await payload.create({
      collection: 'people', data: { name: `Verborgen ${Date.now()}`, hidden: true }, overrideAccess: true,
    })
    const photo = await payload.create({
      collection: 'photos',
      data: { caption: 'verborgen', datePrecision: 'unknown', _status: 'published' },
      filePath: 'tests/fixtures/gesicht-b.jpg',
      overrideAccess: true,
    })
    await runFacesQueue()
    const [row] = await suggestionsFor(photo.id)
    const cookie = await loginCookie(kuratorEmail)
    const res = await fetch(`http://localhost:3000/api/face-suggestions/${row.id}/bestaetigen`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ personId: person.id }),
    })
    expect(res.status).toBe(409)
  })
})
```

- [ ] **Step 7: Full local gate** — including `pnpm exec playwright test --workers=1`; the three existing journeys must stay green (the nav gains a link only for kurator/admin; the e2e users' journeys are unaffected, but confirm rather than assume).

- [ ] **Step 8: Commit** — `feat: /gesichter kurator review page with confirm/reject/undo endpoints`

---

### Task 6: Consent purge, photo-delete cascade, backfill + reconcile tasks

**Files:**
- Create: `src/hooks/purge-face-data.ts`, `src/jobs/faceMaintenance.ts`
- Modify: `src/collections/People.ts`, `src/jobs/purgePapierkorb.ts`, `src/payload.config.ts`
- Test: extend `tests/int/faces.int.test.ts`

**Interfaces:**
- Produces: task slugs `backfillFaces` (input `{}`, output `{enqueued: number}`) and `reconcileHiddenFaceData` (input `{}`, output `{deleted: number}`), both admin-triggered via `POST /api/payload-jobs`, no schedule.

- [ ] **Step 1: The purge hook** — `src/hooks/purge-face-data.ts`:

```typescript
import type { CollectionAfterChangeHook, CollectionAfterDeleteHook, PayloadRequest } from 'payload'

// P2.3 consent coupling. `people.hidden` („Person verbergen (Einwilligung widerrufen)") is the
// single consent boundary for face data too: flipping it on hard-deletes every face-suggestions
// row naming that person, whatever its status — an `offen` row names them, a `bestaetigt` row
// names them AND holds their biometric template, an `abgelehnt` row still names them.
//
// This runs in the same DB transaction as the flag change itself, so withdrawal and purge cannot
// come apart. IRREVERSIBLE: un-setting `hidden` restores nothing. The person is simply tagged by
// hand again until a kurator confirms a new suggestion, which re-indexes them from scratch.
export async function purgeFaceDataForPerson(
  req: PayloadRequest,
  personId: string | number,
): Promise<number> {
  const result = await req.payload.delete({
    collection: 'face-suggestions',
    where: { suggestedPerson: { equals: personId } },
    overrideAccess: true,
    req,
  })
  const deleted = result.docs.length
  if (deleted > 0) {
    req.payload.logger.info({ msg: 'face-data-purged', personId, deleted })
  }
  return deleted
}

export const purgeFaceDataForHiddenPerson: CollectionAfterChangeHook = async ({ doc, previousDoc, req }) => {
  // Same guard shape as syncHiddenPhotos: only act on the false→true transition.
  if (!doc.hidden || previousDoc?.hidden === true) return
  await purgeFaceDataForPerson(req, doc.id)
}

export const purgeFaceDataForDeletedPerson: CollectionAfterDeleteHook = async ({ req, id }) => {
  // No beforeDelete capture needed here, unlike sync-hidden-photos: face-suggestions rows point
  // at the PERSON by id, and we have that id right here on the hook's own arguments.
  await purgeFaceDataForPerson(req, id)
}
```

- [ ] **Step 2: Wire it into `People`** — in `src/collections/People.ts`, extend the hook arrays (order matters: photo visibility is the correctness-critical part and runs first):

```typescript
    afterChange: [syncHiddenPhotos, purgeFaceDataForHiddenPerson],
    beforeDelete: [captureHiddenPhotosBeforePersonDelete],
    afterDelete: [recomputeHiddenPhotosAfterPersonDelete, purgeFaceDataForDeletedPerson],
```

- [ ] **Step 3: The maintenance tasks** — `src/jobs/faceMaintenance.ts`:

```typescript
// Two admin-triggered tasks (no schedule — run via POST /api/payload-jobs, which is admin-only
// per payload.config.ts's jobsCollectionOverrides). Same machinery, aimed in opposite directions.
import type { TaskConfig, TaskHandler } from 'payload'
import { enqueueDetectFaces } from '@/jobs/detectFaces'
import { purgeFaceDataForPerson } from '@/hooks/purge-face-data'

type BackfillIO = { input: Record<string, never>; output: { enqueued: number } }
type ReconcileIO = { input: Record<string, never>; output: { deleted: number } }

/**
 * The owner's full-backfill decision: walk every eligible published photo and enqueue detection
 * for it. Enqueue-only — the `faces` queue's autoRun `limit` is what throttles the actual work,
 * so this returns in seconds even for a large archive and the backlog drains over hours.
 */
export const backfillFacesHandler: TaskHandler<BackfillIO> = async ({ req }) => {
  const photos = await req.payload.find({
    collection: 'photos',
    where: {
      and: [
        { _status: { equals: 'published' } },
        { deletedAt: { exists: false } },
        { hasHiddenPerson: { not_equals: true } },
      ],
    },
    limit: 0,
    pagination: false,
    overrideAccess: true,
    depth: 0,
    req,
  })
  let enqueued = 0
  for (const photo of photos.docs) {
    await enqueueDetectFaces(req, photo.id)
    enqueued++
  }
  req.payload.logger.info({ msg: 'faces-backfill-enqueued', enqueued })
  return { output: { enqueued } }
}

/**
 * Restore hygiene. Face data lives in the main database and is therefore in the backups, so
 * restoring an older dump resurrects templates that a consent withdrawal had already destroyed.
 * This deletes face data for EVERY currently-hidden person — idempotent, a no-op on a healthy
 * system, and a numbered step in the restore recipe in docs/betrieb.md.
 */
export const reconcileHiddenFaceDataHandler: TaskHandler<ReconcileIO> = async ({ req }) => {
  const hidden = await req.payload.find({
    collection: 'people',
    where: { hidden: { equals: true } },
    limit: 0,
    pagination: false,
    overrideAccess: true,
    depth: 0,
    req,
  })
  let deleted = 0
  for (const person of hidden.docs) deleted += await purgeFaceDataForPerson(req, person.id)
  req.payload.logger.info({ msg: 'faces-reconcile-hidden', persons: hidden.docs.length, deleted })
  return { output: { deleted } }
}

export const backfillFacesTask: TaskConfig<BackfillIO> = {
  slug: 'backfillFaces',
  label: 'Gesichtserkennung: Archiv nachtragen',
  handler: backfillFacesHandler,
}

export const reconcileHiddenFaceDataTask: TaskConfig<ReconcileIO> = {
  slug: 'reconcileHiddenFaceData',
  label: 'Gesichtsdaten aufräumen (verborgene Personen)',
  handler: reconcileHiddenFaceDataHandler,
}
```

Register both in `jobs.tasks` in `src/payload.config.ts`.

- [ ] **Step 4: 180-day sweep of stale open suggestions** — in `src/jobs/purgePapierkorb.ts`, at the end of the handler (before the final `logger.info`), add:

```typescript
  // Speicherbegrenzung (Art. 5 Abs. 1 lit. e): an `offen` suggestion nobody ever reviewed is a
  // biometric template for an unidentified person. After 180 days it loses the template and
  // becomes a tombstone, which still stops a re-run resurrecting the same box.
  const staleCutoff = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString()
  const stale = await req.payload.update({
    collection: 'face-suggestions',
    where: {
      and: [{ status: { equals: 'offen' } }, { detectedAt: { less_than: staleCutoff } }],
    },
    data: { status: 'abgelehnt', embedding: null },
    overrideAccess: true,
    req,
  })
  if (stale.docs.length > 0) {
    req.payload.logger.info({ msg: 'face-suggestions-expired', expired: stale.docs.length })
  }
```

- [ ] **Step 5: Extend the int test**

```typescript
describe('consent purge and delete cascade', () => {
  it('hiding a person deletes every face-suggestions row naming them', async () => {
    const person = await payload.create({
      collection: 'people', data: { name: `Purge ${Date.now()}` }, overrideAccess: true,
    })
    const photo = await payload.create({
      collection: 'photos',
      data: { caption: 'purge', datePrecision: 'unknown', _status: 'published' },
      filePath: 'tests/fixtures/gesicht-a.jpg',
      overrideAccess: true,
    })
    await runFacesQueue()
    const [row] = await suggestionsFor(photo.id)
    await payload.update({
      collection: 'face-suggestions', id: row.id,
      data: { status: 'bestaetigt', suggestedPerson: person.id }, overrideAccess: true,
    })
    // present before, so the assertion after cannot pass vacuously
    expect(
      (await payload.find({
        collection: 'face-suggestions',
        where: { suggestedPerson: { equals: person.id } },
        overrideAccess: true, pagination: false,
      })).docs.length,
    ).toBe(1)

    await payload.update({
      collection: 'people', id: person.id, data: { hidden: true }, overrideAccess: true,
    })
    expect(
      (await payload.find({
        collection: 'face-suggestions',
        where: { suggestedPerson: { equals: person.id } },
        overrideAccess: true, pagination: false,
      })).docs.length,
    ).toBe(0)
  })

  it('hard-deleting a photo removes its suggestions via the FK cascade', async () => {
    const photo = await payload.create({
      collection: 'photos',
      data: { caption: 'cascade', datePrecision: 'unknown', _status: 'published' },
      filePath: 'tests/fixtures/gesicht-b.jpg',
      overrideAccess: true,
    })
    await runFacesQueue()
    expect((await suggestionsFor(photo.id)).length).toBeGreaterThanOrEqual(1)
    await payload.delete({ collection: 'photos', id: photo.id, overrideAccess: true })
    expect(await suggestionsFor(photo.id)).toHaveLength(0)
  })

  it('reconcileHiddenFaceData cleans up rows a restore would have resurrected', async () => {
    const person = await payload.create({
      collection: 'people', data: { name: `Restore ${Date.now()}`, hidden: true }, overrideAccess: true,
    })
    const photo = await payload.create({
      collection: 'photos',
      data: { caption: 'restore', datePrecision: 'unknown', _status: 'published' },
      filePath: 'tests/fixtures/gesicht-c.jpg',
      overrideAccess: true,
    })
    await runFacesQueue()
    const [row] = await suggestionsFor(photo.id)
    // simulate a restored backup: a row naming an already-hidden person
    await payload.update({
      collection: 'face-suggestions', id: row.id,
      data: { status: 'bestaetigt', suggestedPerson: person.id }, overrideAccess: true,
    })
    await payload.jobs.queue({ task: 'reconcileHiddenFaceData', input: {} })
    await payload.jobs.run({ overrideAccess: true })
    expect(
      (await payload.find({
        collection: 'face-suggestions',
        where: { suggestedPerson: { equals: person.id } },
        overrideAccess: true, pagination: false,
      })).docs.length,
    ).toBe(0)
  })
})
```

- [ ] **Step 6: Full local gate + commit** — `feat: consent purge of face data, delete cascade, backfill + reconcile tasks`

---

### Task 7: Health field, CI wiring, betrieb.md

**Files:**
- Modify: `src/app/api/health/route.ts`, `.github/workflows/ci.yml`, `docs/betrieb.md`
- Test: extend `tests/int/faces.int.test.ts`

- [ ] **Step 1: Informational health field** — in `src/app/api/health/route.ts`, import `facesEnabled` and `modelsPresent`, compute

```typescript
  // Informational ONLY: never influences `status` and never changes the HTTP code. Uptime Kuma
  // must not page the owner because a face model is missing. modelsPresent() is a cheap
  // fs.existsSync on two paths.
  const faces = !facesEnabled() ? 'aus' : modelsPresent() ? 'bereit' : 'Modell fehlt'
```

and add `faces` to the JSON body, leaving the `status`/HTTP-code logic byte-for-byte unchanged.

- [ ] **Step 2: Int assertion**

```typescript
describe('health reports face readiness without affecting status', () => {
  it('answers 200 and includes the faces field', async () => {
    const res = await fetch('http://localhost:3000/api/health')
    expect(res.status).toBe(200)
    const json = (await res.json()) as { status: string; faces: string }
    expect(json.status).toBe('ok')
    expect(['aus', 'bereit', 'Modell fehlt']).toContain(json.faces)
  })
})
```

- [ ] **Step 3: CI** — in `.github/workflows/ci.yml`, `test` job, **before** the "Start app for integration tests" step:

```yaml
      - name: Cache face models
        uses: actions/cache@v4
        with:
          path: models/faces
          key: face-models-${{ hashFiles('scripts/fetch-face-models.sh') }}

      - name: Fetch face models
        run: scripts/fetch-face-models.sh
```

and add `FACE_MODELS_DIR: models/faces` to the `test` job's `env:` block so both the dev server and
the vitest process resolve the same directory. The `docker` job needs no change — the model stage
and the face probe run as part of `docker compose build`.

- [ ] **Step 4: `docs/betrieb.md`** — new section **„Gesichtserkennung"**, after „Duplikaterkennung beim Hochladen" and before „Monitoring", in that file's existing German and shape (copy-pasteable `sh` blocks, **bold** for the thing that must not be missed, a „Prüfen, ob es läuft:" recipe, and a „Ein paar bewusste Einschränkungen:" list). It must cover:
  - What it does: suggestions only, a human always confirms, nothing is tagged automatically.
  - Ein/Aus via `FACE_DETECTION_ENABLED`; **`true` on this instance** (owner decision). Note that for *other* deployments the recommended posture is to ship with it `false` until a DSFA exists.
  - `Prüfen, ob es läuft:` `docker compose logs app | grep face-detect`, and the `faces` field on `/api/health` (`aus` / `bereit` / `Modell fehlt`) — explicitly **not** a reason for Kuma to alert.
  - Aktivierung: the one-off backfill, how to trigger it (admin `POST /api/payload-jobs` with task `backfillFaces`), that it enqueues one job per published photo and drains at a throttled rate, and how to watch it (`faces-backfill-enqueued` in the logs, then the count of open suggestions on `/gesichter`).
  - **Datenschutz:** biometric data under Art. 9 DSGVO; consent basis = the same `verbergen` boundary as the rest of the archive; guardians consent for minors; no third party and no data transfer (the engine runs in-process); Art. 22 does not apply because a human confirms; the Verzeichnis entry must record that activation includes a full backfill of the existing archive; a written DSFA is recommended.
  - **Model licence:** the InsightFace weights are „for non-commercial research purposes only", which a Verein archive satisfies.
  - **Löschen** — the honest paragraph, roughly verbatim from spec §7:
    > Die Gesichtsdaten liegen in derselben Datenbank wie alles andere und sind deshalb in den Sicherungen enthalten. Wird bei einer Person „verbergen" gesetzt, sind ihre Gesichtsdaten im laufenden Betrieb **sofort und endgültig weg** — in bereits erstellten Sicherungen bleiben sie aber, bis diese Sicherungen turnusmäßig überschrieben werden (30 Tage lokal wie ausgelagert). Danach sind sie auch dort verschwunden. **Nach jedem Restore einer älteren Sicherung muss „Gesichtsdaten aufräumen" laufen**, sonst leben die gelöschten Daten wieder.
    Add `reconcileHiddenFaceData` as a numbered step in the existing restore recipe.
  - Einschränkungen: a wrong confirmation is fixed with **Rückgängig** on `/gesichter`, not by untagging in the admin UI; „Rückgängig" on a person's only confirmed face un-indexes them again; suggestions are best-effort and a failed job just means no suggestions for that photo; matching is a linear scan that wants `pgvector` beyond ~10 000 confirmed faces; unreviewed suggestions lose their biometric template after 180 days.
  - Resources: **no extra container and no RAM tier bump** — the base stack's footprint plus roughly 200–300 MB while a face job runs; a 2 GB VPS remains fine.

- [ ] **Step 5: Full local gate + commit** — `feat: faces health field, CI model fetch, betrieb.md Gesichtserkennung`

---

### Task 8: Ship — PR, CI, review, merge (user gate), deploy + enable + backfill

- [ ] **Step 1:** Full local gate one more time, from a clean tree: `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm test:unit`, `pnpm test:int` (dev server on the test DB), `pnpm exec playwright test --workers=1`, `shellcheck scripts/*.sh`, and the drift check from Task 2 Step 6.
- [ ] **Step 2:** Verify the production image really works before asking anyone to look at it — build and probe **without touching the live stack** (`docker compose build` uses the root compose file but only builds; do **not** `up`):
  ```sh
  docker compose build app
  ```
  The build must reach and pass both probes (`heic ok`, then `faces ok (…)`). If the face probe fails, the feature is broken in the artefact regardless of what the local tests say — fix it here, not after merge.
- [ ] **Step 3:** Push `p2-faces`, open a PR against `main` summarising the spec and, prominently, the two owner decisions this ships under (enable immediately; full backfill at enable). CI must be green: `test`, `e2e`, `docker` (and read `hygiene`, which is advisory). Address CodeRabbit; resolve every thread.
- [ ] **Step 4:** **USER GATE** — ask before merging. Do not merge on your own initiative.
- [ ] **Step 5:** After merge, on `main`, redeploy the live stack — **this is the only step in the plan permitted to touch it**, and only with the user watching:
  ```sh
  docker compose build
  docker compose run --rm migrate
  docker compose -f docker-compose.yml -f docker-compose.local.yml -f docker-compose.tailscale.yml up -d
  ```
  Then `curl -s http://127.0.0.1/api/health` → 200 with `"faces":"bereit"`.
- [ ] **Step 6:** **Enable + backfill** (owner decisions 4 and 5). Confirm `FACE_DETECTION_ENABLED` is `true` (or absent, which defaults to true) in the live `.env`, then trigger the backfill once as an admin and watch it drain:
  ```sh
  docker compose logs -f app | grep -E 'faces-backfill-enqueued|face-detect'
  ```
  Report: how many photos were enqueued, roughly how long the queue took to drain, and how many open suggestions `/gesichter` ends up with.
- [ ] **Step 7:** **Acceptance demo:** on `/gesichter`, confirm one face for a person; reload and check the person now appears on that photo in the archive; find a second photo of the same person in the queue and confirm the suggestion is pre-selected. Then set that person's `verbergen` flag in `/admin` and confirm every one of their suggestions disappears. Report the transcript.

---

## Self-review (done at write time)

- **Spec coverage.** Every numbered spec section maps to a task: §1 engine + §2 runtime integration → T1; §3 data model → T2; §5 trigger/job/degradation → T3; §4 matching → T4; §6 confirm workflow → T5; §7 consent + backups + backfill/reconcile machinery → T6; §5 health field + §9 GDPR text + §10 CI → T7; §11 rollout incl. both owner decisions → T8. Spec §3's retention rules land in T5 Step 2 (reject nulls the embedding) and T6 Step 4 (180-day sweep). Spec §8's access table lands in T2 (collection + field access) and T5 (per-endpoint role checks), asserted in T2 Step 7 and T5 Step 6.
- **No placeholders.** Model URLs, byte counts and SHA-256 digests are real and were verified against the pinned revision; every code block is complete and self-contained. Three places deliberately require the implementer to *verify* rather than assume, each with a stated fallback that does not change the design: the SCRFD output ordering (T1 S6, with a runnable inspection command), the probe's invocation form (T1 S9), and `req.routeParams` / `AutorunCronConfig.limit` (T5 S2, T3 S3). The fixture files are specified by requirement and source category rather than by URL on purpose — the implementer must record actual provenance in `tests/fixtures/README.md`, and inventing a URL here would defeat that.
- **Interface consistency.** `analyseFaces` returns pixel boxes + image dimensions in T1 and is consumed exactly that way in T3, which is the only caller of `normalizeBox`. `Box` has one field-name set (`xMin/yMin/xMax/yMax`) across `faces.ts`, `face-model.ts`, the job and the page; the DB columns are the same names prefixed `box`. Embeddings are `number[]`, L2-normalised and rounded, everywhere — produced in T1, stored in T3, consumed in T4 and re-normalised defensively in T3's acceptance test. `status` values are the ASCII triple `offen`/`bestaetigt`/`abgelehnt` in T2, T3, T4, T5 and T6.
- **Ordering.** T4's matching test depends on T3's job; T5's endpoints depend on T2's fields and T3's rows; T6's cascade test depends on T2's `ON DELETE cascade`, which is why T2 Step 4 makes verifying it an explicit instruction rather than a hope. T3 writes rows with `suggestedPerson` unset and T4 fills it in — both states are valid, so each task ends green on its own.
- **Constraint carriage.** Live-stack protection is a global and is restated at the two moments it could plausibly be violated (T2 Step 1 brings up only `docker-compose.dev.yml`; T8 Steps 2 and 5 spell out build-only vs. the one permitted deploy). The full gate, trailers, migration-drift, SHA-verification, real-WASM CI and public-domain-fixture rules are all globals, and each has at least one task step that actually exercises it.
