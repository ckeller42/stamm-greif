import type {
  Access,
  CollectionAfterDeleteHook,
  CollectionBeforeChangeHook,
  CollectionBeforeDeleteHook,
  CollectionBeforeOperationHook,
  CollectionConfig,
  FieldAccess,
  Where,
} from 'payload'
import { ValidationError } from 'payload'
import sharp from 'sharp'
import exifReader from 'exif-reader'
import { isAdmin } from '@/access/roles'
import { fuzzyDateFields } from '@/fields/fuzzy-date'
import { de } from '@/messages/de'
import { computeExifFill, resolveIncomingDateFields, type ParsedExif } from '@/lib/exif-fill'
import { facesEnabled } from '@/lib/faces'
import { modelsPresent } from '@/lib/face-model'
import { computeDHash, DEGENERATE_HASHES, hammingDistance, isDegenerateHash } from '@/lib/phash'
import { stripImageMetadata } from '@/lib/strip-image-metadata'
import { enqueueDetectFaces } from '@/jobs/detectFaces'

// Spec P2.2: two same-motif scans/re-exports of one slide produce dHashes that differ only in a
// handful of bits (compression noise, minor recrop) — chosen empirically-plausible per the
// design doc, not derived from a measured false-positive/negative study on this archive's own
// photos (there are none yet to study). 8 of 64 bits (12.5%) is comfortably below the ~32-bit
// (50%) distance two *unrelated* photos land around on average, while staying loose enough to
// catch a lightly-recompressed re-export. This is a moderation HINT, never a hard block (see
// canUpdatePhoto/create access below — duplicateSuspected is informational only, nothing in this
// file rejects a create because of it).
const DUPLICATE_HAMMING_THRESHOLD = 8

// Alpine's libheif (see Dockerfile) can *decode* HEIC/HEIF but has no HEVC encoder, so it can
// only ever write other formats, never HEIC itself — "heifsave: Unsupported compression" is
// libvips' error for exactly that gap. Payload's own upload pipeline re-encodes the *original*
// file through sharp for any format it considers resizable (EXIF auto-rotation, mostly) the
// moment resizeOptions/formatOptions/trimOptions/constructorOptions are configured — so simply
// allowlisting image/heic in `mimeTypes` below and leaving it at that would make every HEIC
// upload hit that same "not built in" wall the moment any of those got configured, not just
// resizes. Converting to JPEG ourselves *before* Payload's pipeline ever sees a HEIC mimetype
// sidesteps that entirely: from this hook onward the file just looks like a completely ordinary
// JPEG upload, going through the exact same well-exercised code path every JPEG/PNG/TIFF/WebP
// upload already does.
//
// Note this project never enables Payload's `useTempFiles` (payload.config.ts's default,
// `false`, is left as-is), so `req.file.data` is always the full in-memory buffer — no
// tempFilePath branch needed here.
const HEIC_FTYP_BRANDS = new Set(['heic', 'heix', 'heif', 'mif1', 'msf1'])

// Structural check, not a trust of the declared Content-Type: an ISOBMFF `ftyp` box (bytes 4-7
// literally spell "ftyp") naming a HEIC/HEIF brand (bytes 8-11). This is what actually gates
// decoding below, for two reasons that cut in opposite directions:
// - a real HEIC file the client mislabeled (e.g. sent as application/octet-stream, which
//   browsers do for HEIC fairly often) still gets caught and converted here, because this
//   doesn't depend on what the client claimed at all;
// - conversely, we never hand arbitrary attacker-controlled bytes to libheif just because a
//   request *declared* Content-Type: image/heic — an authenticated member could otherwise feed
//   any bytes they like straight into the decoder. If the declared mimetype says HEIC but the
//   bytes don't structurally look like one, this function returns false, the hook below leaves
//   the file untouched, and Payload's own checkFileRestrictions (content-sniffing the *real*
//   type) is what decides whether to reject it — not us, and not libheif.
function looksLikeHeic(buf: Buffer): boolean {
  return (
    buf.length >= 12 &&
    buf.toString('ascii', 4, 8) === 'ftyp' &&
    HEIC_FTYP_BRANDS.has(buf.toString('ascii', 8, 12))
  )
}

// Reads whatever EXIF the ORIGINAL upload already carries — volunteers entering 40 years of
// metadata by hand is the actual bottleneck this exists to relieve. Must run before
// convertHeicToJpeg (see hooks.beforeOperation order below): that hook re-encodes HEIC through
// sharp's JPEG encoder, which does not carry EXIF forward, so by the time it's done there is
// nothing left to read. Stashed on req.context (Payload's dedicated hook-to-hook scratch space)
// rather than mutated onto `data` here, because beforeOperation's `args` shape varies by
// operation and isn't guaranteed to carry `data` in a stable, typed way — applyExifFill below
// (a proper beforeChange hook, which does have a stable typed `data`) is where it actually gets
// applied.
//
// try/catch is load-bearing, not defensive boilerplate: sharp's own prebuilt binary (what
// host-dev / CI's `pnpm dev` webServer uses) cannot decode HEIC at all — see heic.int.test.ts's
// top-of-file comment for the full writeup of that gap. A HEIC upload's EXIF then simply isn't
// extracted there (fields stay empty; nothing breaks), while the production container (system
// libvips + libheif, per the Dockerfile) reads it fine. JPEG/PNG/TIFF EXIF works unconditionally
// everywhere, since none of them need libheif to decode.
const extractExifOnUpload: CollectionBeforeOperationHook = async ({ req, operation }) => {
  if (operation !== 'create' && operation !== 'update') return
  const file = req.file
  if (!file) return
  try {
    const metadata = await sharp(file.data).metadata()
    if (metadata.exif) {
      ;(req.context as { exif?: ParsedExif }).exif = exifReader(metadata.exif) as ParsedExif
    }
  } catch (err) {
    // Corrupt/unreadable EXIF, or (host-dev) a HEIC file sharp's prebuilt binary can't decode at
    // all — degrade silently. This is purely an enrichment step; it must never block or fail an
    // upload the way convertHeicToJpeg's decode errors correctly do.
    req.payload.logger.info({ msg: 'exif-extract-skipped', reason: err instanceof Error ? err.message : String(err) })
  }
}

const convertHeicToJpeg: CollectionBeforeOperationHook = async ({ req, operation }) => {
  if (operation !== 'create' && operation !== 'update') return
  const file = req.file
  if (!file || !looksLikeHeic(file.data)) return
  let jpegBuffer: Buffer
  try {
    // rotate() bakes in orientation before the re-encode strips metadata — kept for the same
    // reason Payload's own pipeline always calls it too, and it's a correct no-op here rather
    // than dead weight. But note (verified via direct testing, tests/int/heic.int.test.ts has
    // the full writeup): for HEIC/HEIF specifically, this call doesn't actually do anything.
    // libvips' HEIF loader applies both forms of HEIC orientation it recognizes — the `irot`
    // transformative property (what real photos use) and, empirically, embedded EXIF
    // Orientation tags too when present — unconditionally at *decode* time, before sharp's
    // JS-level rotate() logic (designed for formats like JPEG/TIFF that defer orientation to
    // the caller) ever gets a chance to act. Confirmed with three independent test fixtures
    // that calling/not-calling rotate() produces byte-identical dimensions for every one.
    jpegBuffer = await sharp(file.data).rotate().jpeg({ quality: 90 }).toBuffer()
  } catch (err) {
    // A file that structurally looks like a HEIC container (looksLikeHeic passed) but is
    // truncated, corrupt, or uses a codec/profile libheif doesn't support still reaches here —
    // sharp/libvips throws a raw Error with English internals-facing text (e.g. "heif: ..."),
    // which would otherwise surface as an uncaught 500 with that text shown to the user.
    // ValidationError gives a proper 400 with German copy instead, same shape as any other
    // field-validation failure this collection produces.
    req.payload.logger.error(err)
    throw new ValidationError(
      {
        collection: 'photos',
        errors: [
          {
            path: 'file',
            message:
              'Die HEIC-Datei konnte nicht verarbeitet werden — bitte als JPEG exportieren und erneut hochladen.',
          },
        ],
        req,
      },
      req.t,
    )
  }
  const jpegName = file.name.replace(/\.[^./]+$/, '') + '.jpg'
  req.file = { ...file, data: jpegBuffer, mimetype: 'image/jpeg', name: jpegName, size: jpegBuffer.length }
}

// P2 consent audit, C1: scrub location/identity metadata (EXIF GPS, XMP, IPTC) from the bytes that
// will actually be STORED as the original, so the anonymous kiosk download route and Payload's own
// /api/photos/file/:filename — both of which stream the original blob and neither of which passes
// through the kurator-only exifLat/exifLng field access — can never hand a photo's coordinates to a
// member or a guest. Must run AFTER extractExifOnUpload (which has already read the GPS into the DB
// fields, where curators keep access to it) and AFTER convertHeicToJpeg (HEIC is JPEG by now, and
// carries no EXIF, so this is a no-op on it). Fail CLOSED: if the scrub can't be completed, reject
// the upload with a 400 rather than persist an original we couldn't clean — a leak is worse than a
// rejected upload the member can retry.
// Only the raster types we actually store and know how to scrub. Anything else (a disallowed GIF,
// or a HEIC that failed the sniff and stayed unconverted) is deliberately skipped here so Payload's
// own checkFileRestrictions — which runs AFTER this beforeOperation hook — still owns the
// "Invalid MIME type" rejection for it, rather than this hook pre-empting that with its own error.
const STRIPPABLE_MIMETYPES = new Set(['image/jpeg', 'image/png', 'image/tiff', 'image/webp'])

const stripMetadataOnUpload: CollectionBeforeOperationHook = async ({ req, operation }) => {
  if (operation !== 'create' && operation !== 'update') return
  const file = req.file
  if (!file || !STRIPPABLE_MIMETYPES.has(file.mimetype)) return
  try {
    const stripped = await stripImageMetadata(file.data, file.mimetype)
    req.file = { ...file, data: stripped, size: stripped.length }
  } catch (err) {
    req.payload.logger.error({
      msg: 'metadata-strip-failed',
      name: file.name,
      mimetype: file.mimetype,
      error: err instanceof Error ? err.message : String(err),
    })
    throw new ValidationError(
      {
        collection: 'photos',
        errors: [
          {
            path: 'file',
            message:
              'Die Bilddatei konnte nicht verarbeitet werden — bitte als JPEG exportieren und erneut hochladen.',
          },
        ],
        req,
      },
      req.t,
    )
  }
}

// Computes the dHash (spec P2.2) of the file bytes that will actually be STORED — must run AFTER
// convertHeicToJpeg in the beforeOperation array (see hooks.beforeOperation order below), the
// same way extractExifOnUpload must run BEFORE it for the opposite reason: EXIF needs the
// original bytes (HEIC re-encode drops EXIF), while the perceptual hash needs to describe the
// final artifact a future duplicate check will compare against, not an intermediate HEIC blob
// nothing else in the system ever sees again. Stashed on req.context (same pattern as
// extractExifOnUpload's req.context.exif) since beforeOperation's `args` shape isn't guaranteed
// to carry a stable, typed `data` — applyPhash below (a beforeChange hook) is where it's actually
// written and where the duplicate check runs.
//
// try/catch is load-bearing: this is purely an enrichment/detection step and must never block or
// fail an upload sharp can't decode for some other reason (corrupt file, unsupported format) —
// that class of failure is Payload's own checkFileRestrictions / convertHeicToJpeg's job to
// reject, not this hook's.
const computePhashOnUpload: CollectionBeforeOperationHook = async ({ req, operation }) => {
  if (operation !== 'create' && operation !== 'update') return
  const file = req.file
  if (!file) return
  try {
    const raw = await sharp(file.data).grayscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer()
    ;(req.context as { phash?: string }).phash = computeDHash(raw)
  } catch (err) {
    req.payload.logger.info({
      msg: 'phash-compute-skipped',
      reason: err instanceof Error ? err.message : String(err),
    })
  }
}

// Applies extractExifOnUpload's stashed req.context.exif to the actual document data. Split
// from that hook because beforeChange (unlike beforeOperation) has a stable, typed `data` to
// merge into — see extractExifOnUpload's comment for why the two are separate hooks.
const applyExifFill: CollectionBeforeChangeHook = ({ req, data, originalDoc }) => {
  const exif = (req.context as { exif?: ParsedExif }).exif
  if (!exif) return data
  // Fix round 1 (M3): see resolveIncomingDateFields' own comment (src/lib/exif-fill.ts) for why
  // a plain `data.datePrecision`/`data.dateValue` read isn't enough on a partial update.
  const fill = computeExifFill(exif, resolveIncomingDateFields(data, originalDoc))
  // Fix round 1 (L4): clear it once consumed. req.context is scoped to the whole REQUEST, not
  // to one document — a bulk `update` by `where` (matching more than one doc) would reuse this
  // same req/context across every matched doc's beforeChange call. Today's real entry points
  // (member upload, admin single-doc edit) never attach a file to a multi-doc update — Payload
  // has no such endpoint — so this can't happen on any path this app actually exposes, but
  // clearing it after the first (and, in practice, only) consumer keeps the hook correct even
  // if that ever changes, at zero cost here.
  delete (req.context as { exif?: ParsedExif }).exif
  return { ...data, ...fill }
}

// Applies computePhashOnUpload's stashed req.context.phash, and — on CREATE only — runs the
// duplicate-suspicion check against every existing photo's stored hash (spec P2.2).
//
// CREATE only, deliberately: an update's own file-replace path isn't the scenario this exists
// for (re-uploading over an existing document isn't "the same slide scanned twice", it's editing
// one document), and re-running the full-table scan on every metadata-only edit (caption/date/
// tag changes, the vast majority of updates) would be pure waste — those never touch req.file at
// all, so req.context.phash is simply absent and this returns immediately below.
//
// The full-table scan (`select: { phash: true }, pagination: false, depth: 0`) is the design's
// explicitly chosen approach — "at 10k photos this is trivial in-process" — over any DB-side
// nearest-neighbor structure; hamming distance over a 64-bit int has no simple index-friendly
// range query, and 10k rows of just an id + 16-char string is a trivial fetch either way.
// `overrideAccess: true` is required and safe: this is a system-internal comparison, never
// returned to the client, over ALL photos regardless of draft/soft-delete/hidden-person state —
// exactly the corpus a real duplicate could be hiding in.
const applyPhash: CollectionBeforeChangeHook = async ({ req, data, operation }) => {
  const phash = (req.context as { phash?: string }).phash
  if (!phash) return data
  // Fix-round pattern reused from applyExifFill (P2.1, L4): req.context is scoped to the whole
  // request, not one document — clear immediately after reading so a hypothetical future
  // multi-document write path can't leak one doc's hash onto another's.
  delete (req.context as { phash?: string }).phash
  if (operation !== 'create') return { ...data, phash }

  // Built separately and spread at the end (rather than mutating a `next` object in place) so
  // the "no duplicate found" path is a true no-op on the return shape — same style
  // applyExifFill above uses for its own `fill` object.
  let duplicateFields: { duplicateOf?: number; duplicateSuspected?: boolean } = {}

  // m2 (review): a degenerate hash (see isDegenerateHash's own comment) carries no comparison
  // evidence in EITHER direction — this upload's own hash is still stored below (phash is always
  // recorded; only the COMPARISON is skipped), but it can never itself be flagged, and it must
  // never serve as a match target for some later, genuinely unrelated upload either. The `where`
  // clause below excludes existing degenerate hashes from the candidate corpus for exactly that
  // second reason.
  if (!isDegenerateHash(phash)) {
    try {
      const existing = await req.payload.find({
        collection: 'photos',
        where: {
          and: [
            { phash: { exists: true } },
            { phash: { not_in: Array.from(DEGENERATE_HASHES) } },
          ],
        },
        select: { phash: true },
        pagination: false,
        depth: 0,
        overrideAccess: true,
        req,
      })
      let closestId: number | undefined
      let closestDistance = Infinity
      for (const doc of existing.docs) {
        if (!doc.phash || isDegenerateHash(doc.phash)) continue
        const distance = hammingDistance(phash, doc.phash)
        if (distance < closestDistance) {
          closestDistance = distance
          closestId = doc.id
        }
      }
      // NEVER blocks the upload either way — this only ever adds informational fields for a
      // moderator to review, matching the spec's "flagged, NOT silently duplicated, and NOT
      // hard-blocked" requirement.
      if (closestId !== undefined && closestDistance <= DUPLICATE_HAMMING_THRESHOLD) {
        duplicateFields = { duplicateOf: closestId, duplicateSuspected: true }
      }
    } catch (err) {
      // Same non-fatal contract as computePhashOnUpload: a failed duplicate lookup must never
      // block the actual upload it's trying to enrich.
      req.payload.logger.info({
        msg: 'phash-duplicate-check-skipped',
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return { ...data, phash, ...duplicateFields }
}

// m1 (review, P2.2): when a photo is hard-deleted, any OTHER photo whose duplicateOf pointed at
// it must have duplicateSuspected cleared too. The FK itself (`ON DELETE SET NULL` on
// photos.duplicate_of_id — see the phash_fields migration) already nulls duplicateOf at the DB
// level the instant the row is gone, but the sibling boolean is a separate column the FK has no
// say over, and would otherwise be left stuck at `true`, pointing at nothing.
//
// Capture-then-apply across beforeDelete/afterDelete, not a single afterDelete query: verified
// directly against node_modules/payload/dist/collections/operations/{deleteByID,delete}.js —
// both call `beforeDelete` hooks, THEN `payload.db.deleteOne` (the actual DB delete — what fires
// the FK cascade), THEN `afterDelete` hooks. By the time afterDelete runs, the FK has ALREADY
// nulled every referencing photo's duplicateOf, so a `where: { duplicateOf: { equals: id } }`
// query in afterDelete would find nothing. The referencing ids must be captured BEFORE the
// delete, in beforeDelete, while duplicateOf still points at the doc about to be deleted.
//
// Keyed by the deleted doc's own id on req.context — exact pattern already established by
// src/hooks/sync-hidden-photos.ts's captureHiddenPhotosBeforePersonDelete /
// recomputeHiddenPhotosAfterPersonDelete for the analogous person-deletion cascade — rather than
// a single shared value: Payload's bulk `delete({ where })` (the Papierkorb purge job's own
// delete path, and any future admin bulk-delete) runs every matched doc's beforeDelete/
// afterDelete via `docs.map(async ...)` in collections/operations/delete.js — concurrently, not
// sequentially — so a single shared context value would risk one doc's captured ids being
// clobbered by another's before its own afterDelete gets to read them. Keying by id (globally
// unique regardless of concurrency) avoids that entirely.
const DUPLICATE_CLEANUP_CONTEXT_KEY = 'duplicateCleanupPhotoIds'

const captureDuplicateReferencesBeforeDelete: CollectionBeforeDeleteHook = async ({ req, id }) => {
  try {
    const referencing = await req.payload.find({
      collection: 'photos',
      where: { duplicateOf: { equals: id } },
      select: {},
      pagination: false,
      depth: 0,
      overrideAccess: true,
      req,
    })
    const store = (req.context[DUPLICATE_CLEANUP_CONTEXT_KEY] ??= {}) as Record<string, number[]>
    store[String(id)] = referencing.docs.map((doc) => doc.id)
  } catch (err) {
    // Non-fatal: this is a cleanup enrichment, not a deletion precondition — a failed lookup here
    // must never block the delete itself.
    req.payload.logger.info({
      msg: 'duplicate-cleanup-capture-skipped',
      reason: err instanceof Error ? err.message : String(err),
    })
  }
}

const clearDuplicateFlagsAfterDelete: CollectionAfterDeleteHook = async ({ req, id }) => {
  const store = req.context[DUPLICATE_CLEANUP_CONTEXT_KEY] as Record<string, number[]> | undefined
  const referencingIds = store?.[String(id)]
  if (!referencingIds) return
  delete store[String(id)]
  // Per-id update (the same call shape sync-hidden-photos.ts's recomputePhoto already uses for
  // an analogous propagate-a-boolean cascade) rather than a single bulk `where: { id: { in } }`
  // update: leaves each target document's own `_status`/draft state exactly as Payload's normal
  // single-document update path already handles it, with no new bulk-update behavior to reason
  // about here.
  for (const photoId of referencingIds) {
    try {
      await req.payload.update({
        collection: 'photos',
        id: photoId,
        data: { duplicateOf: null, duplicateSuspected: false },
        overrideAccess: true,
        depth: 0,
        req,
      })
    } catch (err) {
      req.payload.logger.info({
        msg: 'duplicate-cleanup-apply-skipped',
        photoId,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

// P2.3 Task 6: belt-and-braces alongside the DB FK's `ON DELETE cascade` (hand-edited into the
// face_suggestions migration — see that migration file's own comment). Payload's relationship
// field config has no way to express "cascade" itself, only "set null" (its universal default),
// so `pnpm payload migrate` (which replays the hand-edited SQL literally) is the only path that
// ever produces the real cascade constraint. `pnpm dev`'s schema push instead diffs the live DB
// directly against the config-derived schema — always "set null" for this field — and silently
// reverts the constraint on every dev boot (confirmed directly: `\d face_suggestions` after a dev
// boot shows `ON DELETE set null`, even immediately after a `migrate` that just set it to
// `cascade`). Since `photo_id` is NOT NULL, hard-deleting a photo with any face-suggestions rows
// under that reverted constraint throws a 23502 (not-null violation) — INSIDE the `DELETE FROM
// photos` statement itself, since the FK action runs as part of that same SQL statement, before
// Payload's JS-level `afterDelete` hooks ever get a chance to run. That rules out an afterDelete
// cleanup (verified the hard way: adding one there still failed with the identical 23502 — the
// delete never reaches JS at all). `beforeDelete` is what actually closes the gap: removing the
// children first means there is nothing left for the (possibly-reverted) FK action to trip over
// once the real `DELETE FROM photos` runs. A no-op whenever the real FK cascade would have done
// the same work anyway (a `migrate`-only production deploy). Same non-fatal-degradation shape as
// captureDuplicateReferencesBeforeDelete above: a failed cleanup here must not block the delete
// the user actually asked for.
const deleteFaceSuggestionsBeforePhotoDelete: CollectionBeforeDeleteHook = async ({ req, id }) => {
  try {
    await req.payload.delete({
      collection: 'face-suggestions',
      where: { photo: { equals: id } },
      overrideAccess: true,
      req,
    })
  } catch (err) {
    req.payload.logger.info({
      msg: 'face-suggestions-cleanup-skipped',
      photoId: id,
      reason: err instanceof Error ? err.message : String(err),
    })
  }
}

// Field-level access has a slightly different arg shape than collection-level Access (id can be
// string | number), so `isKuratorOrAdmin` from access/roles doesn't structurally match here.
const isKuratorOrAdminField: FieldAccess = ({ req }) =>
  req.user?.role === 'admin' || req.user?.role === 'kurator'

// M1 hardening (review, P2.2): kurator/admin, OR the photo's own uploader. The upload form
// (UploadForm.tsx) needs the uploading mitglied to see their OWN upload's duplicate warning —
// that's the entire point of duplicateSuspected being a separate, member-visible boolean instead
// of just gating everything behind duplicateOf's kurator/admin-only read — but a DIFFERENT
// mitglied browsing/fetching that same photo must not learn anything about a possible duplicate
// they have no stake in.
//
// Verified directly against node_modules/payload/dist/fields/hooks/afterRead/promise.js: field
// read-access is evaluated in Payload's afterRead pass with the FULL parent `doc` already
// populated (`field.access.read({ id: doc.id, data: doc, doc, ... })`), and that same afterRead
// pass runs over the document Payload hands back as the CREATE response too — not just later
// re-fetches — so the uploader's own create response (what uploadOne() in UploadForm.tsx
// actually reads) is covered by the exact same code path as any other read, not a special case.
const canReadDuplicateSuspected: FieldAccess = ({ req, doc }) => {
  if (req.user?.role === 'admin' || req.user?.role === 'kurator') return true
  if (!req.user) return false
  const uploader = doc?.uploader
  const uploaderId = typeof uploader === 'object' && uploader !== null ? uploader.id : uploader
  return uploaderId != null && String(uploaderId) === String(req.user.id)
}

const canReadPhoto: Access = ({ req: { user } }) => {
  if (!user) return false
  if (user.role === 'admin' || user.role === 'kurator') return true
  const where: Where = {
    or: [
      {
        and: [
          { _status: { equals: 'published' } },
          { hasHiddenPerson: { not_equals: true } },
          { deletedAt: { exists: false } },
        ],
      },
      // Own uploads are always visible regardless of draft/soft-delete status — but consent
      // revocation is absolute: even the uploader loses sight of a photo once it tags a person
      // who has been marked hidden.
      { and: [{ uploader: { equals: user.id } }, { hasHiddenPerson: { not_equals: true } }] },
    ],
  }
  return where
}

const canUpdatePhoto: Access = ({ req: { user }, data }) => {
  if (!user) return false
  if (user.role === 'admin' || user.role === 'kurator') return true
  // uploader may edit while still draft — but may not publish or un-delete
  if (data?._status === 'published') return false
  const where: Where = { and: [{ uploader: { equals: user.id } }, { _status: { equals: 'draft' } }] }
  return where
}

export const Photos: CollectionConfig = {
  slug: 'photos',
  labels: { singular: 'Foto', plural: 'Fotos' },
  admin: { group: 'Archiv', defaultColumns: ['filename', 'caption', '_status', 'duplicateOf'] },
  upload: {
    // HEIC/HEIF decode now works (production image compiles sharp against Alpine's system
    // libvips + libheif — see Dockerfile), and convertHeicToJpeg above converts every genuine
    // HEIC/HEIF upload to JPEG before Payload's own upload pipeline ever sees the mimetype. On
    // that normal path, checkFileRestrictions (Payload's mimeTypes enforcement) only ever
    // observes image/jpeg for a HEIC-origin upload — these two entries don't gate it.
    // They still matter for two other things: (1) Payload's admin UI derives the upload
    // widget's file-picker `accept` attribute from this list, so curators/admins uploading
    // via /admin need HEIC listed to even select one; (2) the sniff-bypass path — a file
    // declared image/heic whose bytes don't structurally pass convertHeicToJpeg's magic-byte
    // check (see that function's comment) is deliberately left unconverted, and needs to still
    // be an allowed mimetype for checkFileRestrictions to make its own (correct) call on it
    // rather than being rejected purely for the label.
    mimeTypes: ['image/jpeg', 'image/png', 'image/tiff', 'image/webp', 'image/heic', 'image/heif'],
    imageSizes: [
      { name: 'thumbnail', width: 400 },
      { name: 'web', width: 1600 },
    ],
    adminThumbnail: 'thumbnail',
  },
  versions: { drafts: true },
  access: { read: canReadPhoto, create: ({ req }) => Boolean(req.user), update: canUpdatePhoto, delete: isAdmin },
  hooks: {
    // extractExifOnUpload must run BEFORE convertHeicToJpeg: the latter re-encodes HEIC through
    // sharp's JPEG encoder, which drops EXIF, so by the time it's done there is nothing left to
    // read from the original bytes.
    // computePhashOnUpload must run AFTER convertHeicToJpeg (see its own comment above) — the
    // opposite ordering constraint from extractExifOnUpload, which must run BEFORE it.
    // stripMetadataOnUpload (C1) sits between them: after extractExifOnUpload has read GPS into the
    // DB fields and after convertHeicToJpeg, but before computePhashOnUpload so the phash describes
    // the scrubbed bytes that are actually stored (the strip is lossless for JPEG, so the hash is
    // identical either way — the ordering is for correctness of intent, not a behavioural need).
    beforeOperation: [extractExifOnUpload, convertHeicToJpeg, stripMetadataOnUpload, computePhashOnUpload],
    beforeDelete: [captureDuplicateReferencesBeforeDelete, deleteFaceSuggestionsBeforePhotoDelete],
    afterDelete: [clearDuplicateFlagsAfterDelete],
    // P2.3: face detection runs on the draft→published transition, never on a draft. Member
    // uploads land as drafts and a kurator may delete them unpublished; computing and STORING
    // biometric templates for photos that get thrown away is processing we can simply not do.
    // Also covers a replaced file on an already-published photo. Never throws: a failed enqueue
    // must not fail the publish.
    afterChange: [
      async ({ doc, previousDoc, req, operation }) => {
        if (!facesEnabled()) return
        // Final review, M5: spec §5's degradation story ("FACE_MODELS_DIR missing/incomplete →
        // nothing is enqueued") was only half-true before this — `detectFacesHandler` itself
        // already no-ops when `!modelsPresent()`, but nothing stopped the ENQUEUE from happening
        // first, leaving a dead `payload_jobs` row (queued, run, produced nothing) behind for
        // every publish while a model is missing/incomplete. Checking here too means a degraded
        // deployment doesn't churn the jobs table for work it already knows will be a no-op.
        if (!modelsPresent()) return
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
    beforeChange: [
      async ({ req, data, operation, originalDoc }) => {
        if (operation === 'create' && req.user) {
          data.uploader = req.user.id
          const isModerator = req.user.role === 'admin' || req.user.role === 'kurator'
          // An authenticated non-moderator can never land a new photo already published or
          // already soft-deleted — moderation and Papierkorb are curator/admin-only actions
          // taken as a separate, later update. This is the authoritative guard: it runs for
          // every create by a real user, regardless of entry point (Local API, REST, GraphQL),
          // and cannot be bypassed by omitting/reshaping fields the way an access-control data
          // check sometimes can be. (No req.user at all means a trusted/system context, e.g. an
          // overrideAccess seed/migration — not a mitglied self-publish attempt — so it's left
          // untouched.)
          if (!isModerator) {
            data._status = 'draft'
            delete data.deletedAt
          }
        }
        // recompute hasHiddenPerson from linked people. Partial updates (e.g. the
        // hidden-person sync hook, which only patches `hasHiddenPerson` itself) don't
        // include `people` in `data`, so fall back to the document's existing people.
        const peopleSource = data.people !== undefined ? data.people : originalDoc?.people
        const ids = (peopleSource ?? []).map((p: any) => (typeof p === 'object' ? p.id : p))
        if (ids.length) {
          const res = await req.payload.find({
            collection: 'people',
            where: { and: [{ id: { in: ids } }, { hidden: { equals: true } }] },
            limit: 1,
            overrideAccess: true,
            req,
          })
          data.hasHiddenPerson = res.totalDocs > 0
        } else {
          data.hasHiddenPerson = false
        }
        return data
      },
      applyExifFill,
      applyPhash,
    ],
  },
  fields: [
    { name: 'caption', type: 'text', label: 'Beschreibung' },
    ...fuzzyDateFields(),
    {
      name: 'people',
      type: 'relationship',
      relationTo: 'people',
      hasMany: true,
      label: 'Personen',
      // Spec §7 ("Untagging is not a deletion path... the `photos.people` field description
      // points at it") + final review, M4: removing a person here does NOT delete the underlying
      // face-suggestions row or its embedding — it just edits this list. Fixing a wrong
      // confirmation belongs on /gesichter ("Rückgängig"), which does clean up the biometric data.
      admin: {
        description:
          'Eine falsche Gesichts-Bestätigung wird über „Rückgängig" unter /gesichter korrigiert, ' +
          'nicht durch Entfernen einer Person hier — nur „Rückgängig" räumt auch die gespeicherte ' +
          'Gesichts-Vorlage (Embedding) auf.',
      },
    },
    { name: 'event', type: 'relationship', relationTo: 'events', label: 'Ereignis' },
    { name: 'place', type: 'relationship', relationTo: 'places', label: 'Ort' },
    { name: 'tags', type: 'relationship', relationTo: 'tags', hasMany: true, label: 'Schlagwörter' },
    { name: 'contributor', type: 'text', label: 'Beigesteuert von (z. B. gescannt von)' },
    {
      name: 'uploader',
      type: 'relationship',
      relationTo: 'users',
      admin: { readOnly: true },
      // admin.readOnly is UI-only; without this, the uploader field is still writable via a
      // direct API update. Nobody may reassign it after creation (it's server-set on create).
      access: { update: () => false },
    },
    { name: 'hasHiddenPerson', type: 'checkbox', defaultValue: false, admin: { hidden: true } },
    {
      name: 'deletedAt',
      type: 'date',
      label: 'Gelöscht am (Papierkorb)',
      admin: { position: 'sidebar' },
      // Soft delete (Papierkorb) and un-delete are kurator/admin-only. Without this, a mitglied
      // whose own draft still matches canUpdatePhoto's "own draft" branch could otherwise clear
      // deletedAt themselves and undo a curator's moderation decision.
      access: { update: isKuratorOrAdminField },
    },
    // Raw capture info from the file's own EXIF (applyExifFill above), kept separate from the
    // human-editable fuzzy-date fields above — never overrides them, just records what the file
    // itself already knew. GPS pair powers a future map view; read-only because there's no
    // sensible manual correction UI for either yet, and both are meant to reflect the file, not
    // curator input.
    //
    // CodeRabbit (PR #18): admin.readOnly is UI-only — without `access.create`/`access.update`
    // set to deny, an authenticated client could submit exifTakenAt/exifLat/exifLng directly in
    // `_payload` on upload, and (for a file with no real EXIF) applyExifFill would never
    // overwrite the spoofed value, so it would just persist as submitted.
    //
    // `access: { create: () => false, update: () => false }` mirrors the `uploader` field's
    // existing pattern above and works for the same reason: verified directly against
    // node_modules/payload/dist/collections/operations/create.js's operation order — field
    // access is evaluated in the "beforeValidate - Fields" pass (fields/hooks/beforeValidate/
    // promise.js: `if (!result) delete siblingData[field.name]`), which runs BEFORE "beforeChange
    // - Collection" (where applyExifFill actually sets these fields from real EXIF data). So
    // `access.create`/`update: () => false` strips a client's own directly-submitted value at
    // that earlier gate, while applyExifFill's later hook-driven assignment is a completely
    // separate write path that this gate has already finished running by the time it happens —
    // never re-checked afterward. Confirmed empirically: tests/int/exif.int.test.ts's existing
    // "prefilled from EXIF" cases still pass with this access block in place (the real value
    // still gets stored), and the new spoof-attempt case (real fixture, no EXIF, `_payload`
    // carries a forged exifLat) asserts the forged value is dropped, not stored.
    // exifTakenAt stays read-open to any authenticated reader — a capture date carries roughly
    // the same sensitivity as the fuzzy-date fields above, which already are; only its writes are
    // now locked down.
    {
      name: 'exifTakenAt',
      type: 'date',
      label: 'Aufnahmedatum (EXIF)',
      admin: { readOnly: true, position: 'sidebar' },
      access: { create: () => false, update: () => false },
    },
    // Fix round 1 (M2): GPS coordinates from a modern phone upload are frequently a member's own
    // home/street address, not just "when" but "where a specific device was" — read access is
    // kurator/admin-only, same gate deletedAt's `update` already uses above. Write access locked
    // down too (see exifTakenAt's comment just above for why `create`/`update: () => false` is
    // safe alongside applyExifFill's own writes).
    {
      name: 'exifLat',
      type: 'number',
      label: 'EXIF-Breitengrad',
      admin: { readOnly: true, position: 'sidebar' },
      access: { read: isKuratorOrAdminField, create: () => false, update: () => false },
    },
    {
      name: 'exifLng',
      type: 'number',
      label: 'EXIF-Längengrad',
      admin: { readOnly: true, position: 'sidebar' },
      access: { read: isKuratorOrAdminField, create: () => false, update: () => false },
    },
    // Spec P2.2 — duplicate detection. Three fields, all server-set only (computePhashOnUpload /
    // applyPhash above are the sole writers; every field here locks out client-submitted values
    // the same way exifTakenAt/exifLat/exifLng do, for the same reason CodeRabbit flagged on the
    // previous PR — admin.readOnly alone is UI-only, not an API guarantee).
    {
      name: 'phash',
      type: 'text',
      label: 'Perceptual Hash',
      admin: { readOnly: true, position: 'sidebar' },
      access: { create: () => false, update: () => false },
    },
    // A RELATIONSHIP field leaks the mere EXISTENCE of its target document to anyone who can read
    // this field, regardless of whether they could read the target photo itself — e.g. a hidden/
    // draft photo's id becoming visible to a mitglied via this pointer. Locked to kurator/admin
    // read, same gate exifLat/exifLng already use, so only moderators (who can see every photo
    // anyway) ever see which specific document a suspected duplicate points at.
    {
      name: 'duplicateOf',
      type: 'relationship',
      relationTo: 'photos',
      label: 'Mögliches Duplikat von',
      admin: { readOnly: true, position: 'sidebar' },
      access: { read: isKuratorOrAdminField, create: () => false, update: () => false },
    },
    // The member-facing counterpart to duplicateOf above: a plain boolean carries none of the
    // existence-leak risk a relationship does — but "readable by anyone who can read the photo at
    // all" is still wider than it needs to be: this is exactly what the upload form
    // (UploadForm.tsx) reads to show de.upload.duplicateWarning, and that warning is only ever
    // meant for the person who UPLOADED this specific photo, not every mitglied who happens to
    // browse it later. `canReadDuplicateSuspected` above locks this to kurator/admin OR the
    // photo's own uploader (see its own comment for why the create response is provably covered).
    {
      name: 'duplicateSuspected',
      type: 'checkbox',
      defaultValue: false,
      label: 'Mögliches Duplikat',
      admin: { readOnly: true, position: 'sidebar' },
      access: { read: canReadDuplicateSuspected, create: () => false, update: () => false },
    },
    // P2.4 (kiosk allowlist). A kurator/admin explicitly marks a photo kiosk-safe; ONLY marked
    // photos are eligible for the public beamer — and even then only if they still pass every
    // other consent gate (see src/lib/kiosk-query.ts's kioskPhotoWhere(): this flag is always an
    // extra AND term, never a bypass). Read is open (the boolean is harmless); writes are
    // kurator/admin-only, the same gate as duplicate/exif fields above. The human rule the flag
    // encodes — never mark member-only/minor photos for the public beamer — lives in the admin
    // help text and betrieb.md; the code can only enforce "marked AND still-consented", not the
    // curator's judgement about which photos are safe to mark.
    {
      name: 'kioskFreigegeben',
      type: 'checkbox',
      defaultValue: false,
      label: de.photos.kioskFreigegeben.label,
      admin: { description: de.photos.kioskFreigegeben.help, position: 'sidebar' },
      access: { create: isKuratorOrAdminField, update: isKuratorOrAdminField },
    },
  ],
}
