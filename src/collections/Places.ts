import type { CollectionConfig } from 'payload'
import { authenticated, isAdmin, isKuratorOrAdmin } from '@/access/roles'

export const Places: CollectionConfig = {
  slug: 'places',
  labels: { singular: 'Ort', plural: 'Orte' },
  admin: { useAsTitle: 'name', group: 'Archiv' },
  access: { read: authenticated, create: isKuratorOrAdmin, update: isKuratorOrAdmin, delete: isAdmin },
  fields: [
    { name: 'name', type: 'text', required: true, label: 'Name' },
    {
      name: 'lat', type: 'number', label: 'Breitengrad',
      validate: (v: number | null | undefined) =>
        v == null || (v >= -90 && v <= 90) || 'Breitengrad muss zwischen -90 und 90 liegen',
    },
    {
      name: 'lng', type: 'number', label: 'Längengrad',
      validate: (v: number | null | undefined) =>
        v == null || (v >= -180 && v <= 180) || 'Längengrad muss zwischen -180 und 180 liegen',
    },
    { name: 'notes', type: 'textarea', label: 'Notizen' },
  ],
}
