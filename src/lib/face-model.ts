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
//
// Verified empirically against the actual buffalo_s files (2026-08-09, see task-1-report.md):
// det_500m.onnx has a single input `input.1` and 9 outputs in exactly the assumed order —
// [score_8, score_16, score_32, bbox_8, bbox_16, bbox_32, kps_8, kps_16, kps_32], shapes
// [N,1]/[N,4]/[N,10] per stride (N = grid²·NUM_ANCHORS) — so decodeScrfd's indexing below is
// unmodified from the plan. w600k_mbf.onnx has a single input `input.1` and one output of
// shape [1,512].
import path from 'node:path'
import fs from 'node:fs'
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

let configured = false
function configureOrt(): void {
  if (configured) return
  // Single-threaded on purpose: multi-threaded WASM spawns workers through emscripten's pthread
  // shim, which is exactly the sort of thing that misbehaves under Next's standalone output.
  // One photo takes well under a second either way, on a background queue. Raising this is a
  // one-line follow-up once someone has measured it.
  ort.env.wasm.numThreads = 1
  // Deliberately NOT setting ort.env.wasm.wasmPaths here. Two things ruled out doing it
  // ourselves (verified 2026-08-09, see task-1-report.md): (1) onnxruntime-web's `exports` map
  // has no `./package.json` subpath, so `require.resolve('onnxruntime-web/package.json')`
  // throws ERR_PACKAGE_PATH_NOT_EXPORTED; (2) even resolving the main entry instead breaks
  // under `next build`'s Turbopack output, which rewrites `serverExternalPackages` requires to
  // a hashed alias (`onnxruntime-web-<hash>`) reachable only via a symlink under
  // `.next/node_modules/` — a plain `require.resolve('onnxruntime-web')` run against that
  // compiled chunk cannot find it and throws MODULE_NOT_FOUND. Leaving wasmPaths unset needs
  // neither: the Node bundle (ort.node.min.mjs) locates its own .wasm relative to its own
  // `import.meta.url`, which is correct in every context that matters here — tsx/ts-node
  // against the source tree, and the Turbopack-compiled server, since the .wasm always ships
  // alongside the .mjs in the same `dist` directory regardless of which symlink chain reached
  // it. Confirmed empirically both ways.
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
