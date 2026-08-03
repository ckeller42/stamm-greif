// TODO(Task 6): register this collection in payload.config.ts once 'events' exists.
import type { CollectionConfig } from 'payload'
import { authenticated, isAdmin, isKuratorOrAdmin } from '@/access/roles'

export const Attendance: CollectionConfig = {
  slug: 'attendance',
  labels: { singular: 'Teilnahme', plural: 'Teilnahmen' },
  admin: { group: 'Archiv' },
  access: { read: authenticated, create: isKuratorOrAdmin, update: isKuratorOrAdmin, delete: isAdmin },
  fields: [
    { name: 'person', type: 'relationship', relationTo: 'people', required: true, label: 'Person' },
    // @ts-expect-error — 'events' collection is created and registered in Task 6; Attendance is intentionally unregistered until then (remove this suppression in Task 6)
    { name: 'event', type: 'relationship', relationTo: 'events', required: true, label: 'Ereignis' },
    { name: 'role', type: 'select', required: true, defaultValue: 'teilnehmer', label: 'Rolle',
      options: [
        { label: 'Teilnehmer', value: 'teilnehmer' }, { label: 'Leiter', value: 'leiter' },
        { label: 'Koch', value: 'koch' }, { label: 'Sonstige', value: 'sonstige' },
      ] },
  ],
}
