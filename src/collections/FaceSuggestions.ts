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
