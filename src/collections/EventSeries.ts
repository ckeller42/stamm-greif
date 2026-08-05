import type { CollectionConfig } from 'payload'
import { authenticated, isAdmin, isKuratorOrAdmin } from '@/access/roles'

export const EventSeries: CollectionConfig = {
  slug: 'event-series',
  labels: { singular: 'Ereignisreihe', plural: 'Ereignisreihen' },
  admin: { useAsTitle: 'name', group: 'Archiv' },
  access: { read: authenticated, create: isKuratorOrAdmin, update: isKuratorOrAdmin, delete: isAdmin },
  fields: [
    { name: 'name', type: 'text', required: true, label: 'Name' },
    { name: 'description', type: 'textarea', label: 'Beschreibung' },
  ],
}
