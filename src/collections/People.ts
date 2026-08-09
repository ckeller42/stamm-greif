import type { CollectionConfig } from 'payload'
import { authenticated, isAdmin, isKuratorOrAdmin } from '@/access/roles'
import {
  syncHiddenPhotos,
  captureHiddenPhotosBeforePersonDelete,
  recomputeHiddenPhotosAfterPersonDelete,
} from '@/hooks/sync-hidden-photos'
import { purgeFaceDataForHiddenPerson, purgeFaceDataForDeletedPerson } from '@/hooks/purge-face-data'

export const People: CollectionConfig = {
  slug: 'people',
  labels: { singular: 'Person', plural: 'Personen' },
  admin: { useAsTitle: 'name', group: 'Archiv' },
  access: { read: authenticated, create: isKuratorOrAdmin, update: isKuratorOrAdmin, delete: isAdmin },
  // Review (Task 6, round 2), C2: `payload.update({ collection: 'people', where, data })` — the
  // admin list view's own bulk-edit action, and the equivalent `PATCH /api/people?where=...` REST
  // call — runs `updateOperation` (collections/operations/update.js), which is a SEPARATE code
  // path from the single-document `updateByID` the normal per-person edit view uses.
  // `bulkOperationsSingleTransaction` defaults to false there, so each matched document's write
  // is its own transaction; a hook throwing for one document (e.g. purgeFaceDataForHiddenPerson
  // failing) lands that document's error in the operation's `errors[]` array WITHOUT rolling that
  // document's own already-committed write back and WITHOUT failing the overall HTTP response —
  // confirmed directly: bulk-editing `hidden: true` onto a person whose purge is forced to fail
  // still returns success with `hidden` persisted true. `disableBulkEdit: true` closes exactly
  // this path: verified directly against update.js (`if (args.collection.config.disableBulkEdit
  // && !args.overrideAccess) throw new APIError(...)`) — it throws BEFORE `updateOperation` does
  // anything, for both the admin bulk-edit UI and a raw `PATCH .../people?where=...`, and ONLY
  // when `overrideAccess` is false. `updateByID` (collections/operations/updateByID.js) has no
  // such check at all, so a kurator can still flip one person's `hidden` checkbox from the normal
  // edit view exactly as before, and every internal `overrideAccess: true` caller in this
  // codebase (reconcileHiddenFaceData, backfillFaces, etc.) is entirely unaffected.
  disableBulkEdit: true,
  hooks: {
    // P2.3: order matters — photo visibility (syncHiddenPhotos) is the correctness-critical part
    // and runs first; face-data purge is the consent-boundary cleanup that follows it.
    afterChange: [syncHiddenPhotos, purgeFaceDataForHiddenPerson],
    // purgeFaceDataForDeletedPerson runs beforeDelete, not afterDelete (C1 fix, see that hook's
    // own comment) — it must purge face-suggestions rows BEFORE the person row (and the FK's
    // `ON DELETE set null` action on `suggested_person_id`) disappears out from under its query.
    beforeDelete: [captureHiddenPhotosBeforePersonDelete, purgeFaceDataForDeletedPerson],
    afterDelete: [recomputeHiddenPhotosAfterPersonDelete],
  },
  fields: [
    { name: 'name', type: 'text', required: true, label: 'Name' },
    { name: 'bio', type: 'textarea', label: 'Notizen / Biografie' },
    { name: 'birthYear', type: 'number', label: 'Geburtsjahr' },
    { name: 'hidden', type: 'checkbox', defaultValue: false, label: 'Person verbergen (Einwilligung widerrufen)' },
    { name: 'portrait', type: 'relationship', relationTo: 'photos', label: 'Porträtfoto' },
  ],
}
