// Build-time gate: actually run the whole face pipeline against a real photo with the exact
// models and wasm the container will use. Both silent-failure modes this guards against produce
// a GREEN build otherwise — a missing/untraced .wasm and a missing model directory both surface
// only as "no suggestions ever appear", weeks later. Same reasoning as the HEIC probe that
// already sits at the end of the Dockerfile's run stage.
//
// Invocation form (verify-then-adapt, see task-1-report.md): run via `tsx` directly against
// src/lib/face-model.ts in the Dockerfile's `build` stage, not against the standalone bundle in
// `run`. Two things ruled out the brief's original plan of a tiny re-export entry point read
// from .next/standalone: (1) plain `node --experimental-strip-types` cannot resolve the `@/lib`
// tsconfig path alias face-model.ts imports (`ERR_MODULE_NOT_FOUND '@/lib'`) — it only strips
// types, it does not read tsconfig "paths" — and (2) the `run` stage's node_modules is pruned to
// production deps only, but onnxruntime-web's Node entry is present there either way, and the
// `build` stage already has `tsx` (a devDependency) plus the full TS source tree, so running the
// probe there needs no bundle re-export shim at all. Same assertions as the plan either way; only
// the plumbing changed.
import fs from 'node:fs'
import { analyseFaces } from '../src/lib/face-model.ts'

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
