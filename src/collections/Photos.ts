import type { Access, CollectionBeforeOperationHook, CollectionConfig, FieldAccess, Where } from 'payload'
import fs from 'node:fs/promises'
import sharp from 'sharp'
import { isAdmin } from '@/access/roles'
import { fuzzyDateFields } from '@/fields/fuzzy-date'

// Alpine's libheif (see Dockerfile) can *decode* HEIC/HEIF but has no HEVC encoder, so it can
// only ever write other formats, never HEIC itself — "heifsave: Unsupported compression" is
// libvips' error for exactly that gap. Payload's own upload pipeline re-encodes the *original*
// file through sharp for any format it considers resizable (EXIF auto-rotation, mostly) the
// moment a temp file is involved, regardless of whether resizing/format conversion was actually
// requested — so simply allowlisting image/heic in `mimeTypes` below and leaving it at that
// would make every real (multipart, temp-file) HEIC upload hit that same "not built in" wall,
// not just resizes. Converting to JPEG ourselves *before* Payload's pipeline ever sees a HEIC
// mimetype sidesteps that entirely: from this hook onward the file just looks like a completely
// ordinary JPEG upload, going through the exact same well-exercised code path every JPEG/PNG/
// TIFF/WebP upload already does.
const HEIC_MIME_TYPES = new Set(['image/heic', 'image/heif'])

const convertHeicToJpeg: CollectionBeforeOperationHook = async ({ req, operation }) => {
  if (operation !== 'create' && operation !== 'update') return
  const file = req.file
  if (!file || !HEIC_MIME_TYPES.has(file.mimetype)) return
  const source = file.tempFilePath ? await fs.readFile(file.tempFilePath) : file.data
  // rotate() bakes in the EXIF orientation before the re-encode strips metadata (sharp's
  // default JPEG output drops EXIF, so skipping this would silently un-rotate sideways
  // photos) — the same reason Payload's own pipeline always calls rotate() too.
  const jpegBuffer = await sharp(source).rotate().jpeg({ quality: 90 }).toBuffer()
  const jpegName = file.name.replace(/\.[^./]+$/, '') + '.jpg'
  if (file.tempFilePath) {
    await fs.writeFile(file.tempFilePath, jpegBuffer)
  }
  req.file = { ...file, data: jpegBuffer, mimetype: 'image/jpeg', name: jpegName, size: jpegBuffer.length }
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
    // HEIC/HEIF decode now works: the production image (Dockerfile) compiles sharp from
    // source against Alpine's system libvips, which has HEIC support as a dynamically-loaded
    // module (vips-heif, backed by libheif — see Dockerfile comments for the full chain of
    // packages this needs at both compile and run time). The convertHeicToJpeg beforeOperation
    // hook above uses that decode capability to turn every HEIC/HEIF upload into a JPEG before
    // Payload's own upload pipeline ever runs — see that hook's comment for why converting
    // upfront, rather than just allowlisting the mimetype, is the part that actually matters.
    // Also covers Payload's own hardcoded canResizeImage()/isImage() lists (payload/dist/
    // uploads/{canResizeImage,isImage}.js), which don't recognize image/heic|heif as of
    // 3.87.x — irrelevant here since the hook makes sure Payload never sees that mimetype.
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
    beforeOperation: [convertHeicToJpeg],
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
  ],
}
