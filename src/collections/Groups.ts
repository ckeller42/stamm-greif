import type { CollectionConfig } from 'payload'
import { authenticated, isAdmin, isKuratorOrAdmin } from '@/access/roles'

export const Groups: CollectionConfig = {
  slug: 'groups',
  labels: { singular: 'Gruppe', plural: 'Gruppen' },
  admin: { useAsTitle: 'name', group: 'Archiv' },
  access: { read: authenticated, create: isKuratorOrAdmin, update: isKuratorOrAdmin, delete: isAdmin },
  fields: [
    { name: 'name', type: 'text', required: true, label: 'Name' },
    { name: 'stufe', type: 'select', required: true, label: 'Stufe',
      options: [
        { label: 'Meute', value: 'meute' }, { label: 'Sippe', value: 'sippe' },
        { label: 'Rovertrupp', value: 'rovertrupp' }, { label: 'Leiterrunde', value: 'leiterrunde' },
        { label: 'Stamm', value: 'stamm' },
      ] },
    { name: 'foundedYear', type: 'number', label: 'Gegründet (Jahr)' },
    { name: 'dissolvedYear', type: 'number', label: 'Aufgelöst (Jahr)' },
    { name: 'notes', type: 'textarea', label: 'Notizen' },
  ],
}
