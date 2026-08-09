import type {
  Access,
  CollectionBeforeChangeHook,
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
import { computeExifFill, type ParsedExif } from '@/lib/exif-fill'

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

// Applies extractExifOnUpload's stashed req.context.exif to the actual document data. Split
// from that hook because beforeChange (unlike beforeOperation) has a stable, typed `data` to
// merge into — see extractExifOnUpload's comment for why the two are separate hooks.
const applyExifFill: CollectionBeforeChangeHook = ({ req, data }) => {
  const exif = (req.context as { exif?: ParsedExif }).exif
  if (!exif) return data
  const fill = computeExifFill(exif, { datePrecision: data.datePrecision, dateValue: data.dateValue })
  return { ...data, ...fill }
}

// Field-level access has a slightly different arg shape than collection-level Access (id can be
// string | number), so `isKuratorOrAdmin` from access/roles doesn't structurally match here.
const isKuratorOrAdminField: FieldAccess = ({ req }) =>
  req.user?.role === 'admin' || req.user?.role === 'kurator'

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
  admin: { group: 'Archiv', defaultColumns: ['filename', 'caption', '_status'] },
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
    beforeOperation: [extractExifOnUpload, convertHeicToJpeg],
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
    ],
  },
  fields: [
    { name: 'caption', type: 'text', label: 'Beschreibung' },
    ...fuzzyDateFields(),
    { name: 'people', type: 'relationship', relationTo: 'people', hasMany: true, label: 'Personen' },
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
    {
      name: 'exifTakenAt',
      type: 'date',
      label: 'Aufnahmedatum (EXIF)',
      admin: { readOnly: true, position: 'sidebar' },
    },
    {
      name: 'exifLat',
      type: 'number',
      label: 'EXIF-Breitengrad',
      admin: { readOnly: true, position: 'sidebar' },
    },
    {
      name: 'exifLng',
      type: 'number',
      label: 'EXIF-Längengrad',
      admin: { readOnly: true, position: 'sidebar' },
    },
  ],
}
