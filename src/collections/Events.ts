import type { CollectionConfig } from 'payload'
import { authenticated, isAdmin, isKuratorOrAdmin } from '@/access/roles'
import { fuzzyDateFields } from '@/fields/fuzzy-date'

export const Events: CollectionConfig = {
  slug: 'events',
  labels: { singular: 'Ereignis', plural: 'Ereignisse' },
  admin: { useAsTitle: 'name', group: 'Archiv' },
  access: { read: authenticated, create: isKuratorOrAdmin, update: isKuratorOrAdmin, delete: isAdmin },
  fields: [
    { name: 'name', type: 'text', required: true, label: 'Name' },
    { name: 'series', type: 'relationship', relationTo: 'event-series', label: 'Reihe' },
    { name: 'place', type: 'relationship', relationTo: 'places', label: 'Ort' },
    { name: 'story', type: 'richText', label: 'Geschichte' },
    ...fuzzyDateFields(),
    { name: 'endDate', type: 'date', label: 'Ende (optional)' },
  ],
}
