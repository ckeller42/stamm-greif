// Integration: real HEIC/HEIF uploads over the actual HTTP API. Needs the server running
// against the TEST database — same setup as invites.int.test.ts (see its top-of-file comment).
//
// Capability-gated (see `heicCapable` below): sharp's OWN prebuilt binary — what a `pnpm dev`
// webServer on a CI runner uses — cannot decode real HEIC (only AVIF, which shares the same
// libheif-backed container format but isn't patent-encumbered the same way), so these tests
// would throw a real decode error and fail there, not skip cleanly, if left unconditional.
//
// heicCapable is a REAL functional probe (attempt an actual tiny decode), not a static
// self-report. `sharp.format.heif.input.fileSuffix` looked like the obvious thing to check
// instead, but it can't work: it's a hardcoded literal in sharp's own source
// (node_modules/sharp/lib/utility.js): `format.heif.input.fileSuffix = ['.avif']`, deliberately
// set ONLY when sharp detects it's using its vendored prebuilt libvips (`!libvipsVersion.
// isGlobal`) — a fixed "prebuilt binaries provide AV1[, not HEIC]" declaration, not a live
// capability check. Two consequences that ruled it out: (1) it's always false for '.heic', in
// every sharp installation that has ever existed, prebuilt or not — gating on it would skip
// these tests forever, everywhere, including inside a genuinely HEIC-capable build; (2) this
// project's production build sets SHARP_FORCE_GLOBAL_LIBVIPS=1 (Dockerfile), so
// `!libvipsVersion.isGlobal` is false and the field never even gets set at all — confirmed
// directly against the built image: `sharp.format.heif.input` there is
// `{file:false,buffer:false,stream:false}`, no fileSuffix key.
//
// The thing these tests verify — that Alpine's system libvips + vips-heif genuinely decodes
// HEIC through the actual HTTP/hook path — is proven unconditionally, separately, and more
// cheaply by the Dockerfile's `run`-stage build-time probe (COPY tests/fixtures/dia.heic + a
// hard `RUN node -e "require('sharp')(...)"` gate; see that stage's comment), which fails
// `docker build` itself if decode stops working. These tests exist for the additional coverage
// a raw sharp() call can't give — orientation correctness, corrupt-file error handling, and the
// full request path — which is exactly why they need their own capability check rather than
// just trusting "the image built, so HEIC works": running vitest itself on the host (`pnpm
// dev`-backed CI job) never gets a HEIC-capable sharp even when the *server* being tested does
// (verified: running vitest inside a container sharing the built image's network namespace,
// with the exact same compiled sharp the server uses, still gets heicCapable === true here only
// via the real decode attempt below — the fileSuffix field stays unset either way).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getPayload, type Payload } from 'payload'
import config from '@payload-config'
import sharp from 'sharp'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

let heicCapable = false
try {
  const probeBytes = await readFile(path.resolve(process.cwd(), 'tests/fixtures/dia.heic'))
  await sharp(probeBytes).jpeg().toBuffer()
  heicCapable = true
} catch {
  heicCapable = false
}

let payload: Payload
let memberEmail: string
const password = 'geheim123'
const createdPhotoIds: number[] = []

beforeAll(async () => {
  payload = await getPayload({ config: await config })
  memberEmail = `heic${Date.now()}@example.com`
  await payload.create({
    collection: 'users',
    data: { name: 'Heic Test', email: memberEmail, password, role: 'mitglied' },
    overrideAccess: true,
  })
})

afterAll(async () => {
  if (createdPhotoIds.length) {
    await payload.delete({ collection: 'photos', where: { id: { in: createdPhotoIds } }, overrideAccess: true })
  }
})

async function loginCookie(): Promise<string> {
  const res = await fetch('http://localhost:3000/api/users/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: memberEmail, password }),
  })
  expect(res.ok).toBe(true)
  return res.headers.get('set-cookie') ?? ''
}

async function uploadFixture(fixture: string, filename: string) {
  const cookie = await loginCookie()
  const body = new FormData()
  const bytes = await readFile(path.resolve(process.cwd(), 'tests/fixtures', fixture))
  body.append('file', new Blob([bytes], { type: 'image/heic' }), filename)
  body.append('_payload', JSON.stringify({ datePrecision: 'unknown', _status: 'draft' }))
  const res = await fetch('http://localhost:3000/api/photos', { method: 'POST', headers: { cookie }, body })
  return res
}

describe('HEIC upload', () => {
  it.skipIf(!heicCapable)(
    'a genuine HEIC upload succeeds, decodes, and generates a real JPEG thumbnail',
    async () => {
      // Real HEIC bytes (tests/fixtures/dia.heic — 400x400, generated from dia.jpg via `sips`),
      // not just a declared content-type. 400px matches the `thumbnail` imageSize's width
      // exactly, so — unlike the tiny 100x100 dia.jpg — this fixture is large enough that
      // Payload's default no-upscale behavior does NOT omit it, and the thumbnail generation
      // path (decode -> resize -> re-encode as JPEG, since Alpine's libheif can decode HEIC but
      // not re-encode it) actually runs end-to-end.
      const res = await uploadFixture('dia.heic', 'foto.heic')
      const json = (await res.json()) as {
        doc?: {
          id: number; _status: string; width?: number; height?: number
          mimeType?: string; filename?: string
          sizes?: { thumbnail?: { filename?: string; width?: number; height?: number } }
        }
        errors?: { message: string }[]
      }
      expect(res.status, JSON.stringify(json.errors)).toBe(201)
      if (json.doc?.id) createdPhotoIds.push(json.doc.id)
      expect(json.doc?._status).toBe('draft')
      // The stored file is JPEG, not HEIC: convertHeicToJpeg (Photos.ts) converts on the way
      // in, because Alpine's libheif can decode HEIC but has no HEVC encoder to write it back
      // out (see that hook's comment) — and because a HEIC file sitting in the archive
      // unconverted wouldn't even render in most browsers.
      expect(json.doc?.mimeType).toBe('image/jpeg')
      expect(json.doc?.filename).toMatch(/\.jpg$/)
      expect(json.doc?.width).toBe(400)
      expect(json.doc?.height).toBe(400)
      expect(json.doc?.sizes?.thumbnail?.filename).toMatch(/\.jpg$/)
      expect(json.doc?.sizes?.thumbnail?.width).toBe(400)
    },
  )

  it.skipIf(!heicCapable)(
    'orientation: a non-square HEIC keeps its stored dimensions in proportion (no missed/double rotate)',
    async () => {
      // dia.jpg is exactly square (100x100), so it can't catch a width/height-swap regression
      // on its own — tests/fixtures/dia-portrait.heic is a genuinely non-square 100x150
      // portrait, built by physically rotating a 150x100 landscape intermediate 90 degrees
      // (pixel data, not just an EXIF orientation tag) before encoding to HEIC. This guards the
      // general width/height-through-the-pipeline path (decode -> convert -> store), the same
      // way it would catch e.g. width/height getting swapped or truncated anywhere in
      // convertHeicToJpeg or Payload's own dimension handling.
      //
      // What this test does NOT prove, despite an earlier version of this comment claiming it
      // did: that convertHeicToJpeg's `.rotate()` call specifically matters for HEIC. Verified
      // directly (CodeRabbit review on PR #15 questioned this, correctly) that it doesn't, for
      // any HEIC orientation encoding constructible with the tools available: this fixture's
      // pixels are already physically rotated with no orientation metadata at all, so
      // `.rotate()` has nothing to act on here. Tried two more fixtures specifically to find
      // one where `.rotate()`'s presence vs. absence changes the outcome: (1) a landscape HEIC
      // with an EXIF Orientation=6 tag written via `exiftool` — libvips' HEIF loader doesn't
      // read it at all (`sharp(...).metadata().orientation` comes back `undefined`, dimensions
      // stay unrotated with or without `.rotate()`); (2) the same HEIC with its `irot` (Image
      // Rotation) box — the HEIF-native transform property `sips` already writes, defaulted to
      // 0° — binary-patched to 90°: libvips' HEIF loader auto-applies `irot` unconditionally at
      // *decode* time, before sharp's JS-level `.rotate()` ever runs, so `sharp(buf).metadata()`
      // already reports the rotated 100x150 with no `.rotate()` call involved, and calling
      // `.rotate()` afterward is provably a no-op (identical output either way, confirmed via
      // `resolveWithObject` byte-identical dimensions). In short: for the HEIC/HEIF codepath
      // specifically, decode-time orientation is libvips' job, not sharp's `.rotate()`'s.
      // `.rotate()` stays in convertHeicToJpeg regardless — it's a correct, harmless no-op for
      // HEIC here, and the function's own comment no longer claims otherwise — but no fixture
      // can turn its removal into a test failure through this codepath, so this test is kept
      // for its actual value (a real width/height/proportion regression net) and no longer
      // described as an orientation/rotate() regression test.
      const res = await uploadFixture('dia-portrait.heic', 'portrait.heic')
      const json = (await res.json()) as {
        doc?: { id: number; width?: number; height?: number }
        errors?: { message: string }[]
      }
      expect(res.status, JSON.stringify(json.errors)).toBe(201)
      if (json.doc?.id) createdPhotoIds.push(json.doc.id)
      expect(json.doc?.width).toBe(100)
      expect(json.doc?.height).toBe(150)
      expect(json.doc?.width).toBeLessThan(json.doc?.height ?? 0)
    },
  )

  it.skipIf(!heicCapable)(
    'a structurally-valid-but-corrupt HEIC fails cleanly with a German validation error, not a raw 500',
    async () => {
      // Keep the real ftyp/brand header (bytes 0-11) so looksLikeHeic() in Photos.ts still
      // gates this into the decode attempt, but corrupt everything after it — this exercises
      // convertHeicToJpeg's try/catch around the actual sharp decode, not the sniff itself.
      const realBytes = await readFile(path.resolve(process.cwd(), 'tests/fixtures/dia.heic'))
      const corrupted = Buffer.from(realBytes)
      corrupted.fill(0, 12)
      const cookie = await loginCookie()
      const body = new FormData()
      body.append('file', new Blob([corrupted], { type: 'image/heic' }), 'kaputt.heic')
      body.append('_payload', JSON.stringify({ datePrecision: 'unknown', _status: 'draft' }))
      const res = await fetch('http://localhost:3000/api/photos', { method: 'POST', headers: { cookie }, body })
      expect(res.status).toBe(400)
      const json = (await res.json()) as { errors?: { message: string; data?: { errors?: { message: string }[] } }[] }
      expect(json.errors?.[0]?.data?.errors?.[0]?.message).toBe(
        'Die HEIC-Datei konnte nicht verarbeitet werden — bitte als JPEG exportieren und erneut hochladen.',
      )
    },
  )
})
