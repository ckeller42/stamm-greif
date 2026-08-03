import type { CollectionConfig } from 'payload'
import { authenticated, isAdmin, isKuratorOrAdmin } from '@/access/roles'

export const Places: CollectionConfig = {
  slug: 'places',
  labels: { singular: 'Ort', plural: 'Orte' },
  admin: { useAsTitle: 'name', group: 'Archiv' },
  access: { read: authenticated, create: isKuratorOrAdmin, update: isKuratorOrAdmin, delete: isAdmin },
  fields: [
    { name: 'name', type: 'text', required: true, label: 'Name' },
    { name: 'lat', type: 'number', label: 'Breitengrad' },
    { name: 'lng', type: 'number', label: 'Längengrad' },
    { name: 'notes', type: 'textarea', label: 'Notizen' },
  ],
}
