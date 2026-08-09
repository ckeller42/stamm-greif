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
  hooks: {
    // P2.3: order matters — photo visibility (syncHiddenPhotos) is the correctness-critical part
    // and runs first; face-data purge is the consent-boundary cleanup that follows it.
    afterChange: [syncHiddenPhotos, purgeFaceDataForHiddenPerson],
    beforeDelete: [captureHiddenPhotosBeforePersonDelete],
    afterDelete: [recomputeHiddenPhotosAfterPersonDelete, purgeFaceDataForDeletedPerson],
  },
  fields: [
    { name: 'name', type: 'text', required: true, label: 'Name' },
    { name: 'bio', type: 'textarea', label: 'Notizen / Biografie' },
    { name: 'birthYear', type: 'number', label: 'Geburtsjahr' },
    { name: 'hidden', type: 'checkbox', defaultValue: false, label: 'Person verbergen (Einwilligung widerrufen)' },
    { name: 'portrait', type: 'relationship', relationTo: 'photos', label: 'Porträtfoto' },
  ],
}
