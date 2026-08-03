import type { Access, CollectionConfig, FieldAccess, Where } from 'payload'
import { isAdmin } from '@/access/roles'
import { fuzzyDateFields } from '@/fields/fuzzy-date'

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
    mimeTypes: ['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/tiff', 'image/webp'],
    imageSizes: [
      { name: 'thumbnail', width: 400 },
      { name: 'web', width: 1600 },
    ],
    adminThumbnail: 'thumbnail',
  },
  versions: { drafts: true },
  access: { read: canReadPhoto, create: ({ req }) => Boolean(req.user), update: canUpdatePhoto, delete: isAdmin },
  hooks: {
    beforeChange: [
      async ({ req, data, operation, originalDoc }) => {
        if (operation === 'create' && req.user) data.uploader = req.user.id
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
