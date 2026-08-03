import type { CollectionConfig } from 'payload'
import { authenticated, isAdmin, isKuratorOrAdmin } from '@/access/roles'

export const Tags: CollectionConfig = {
  slug: 'tags',
  labels: { singular: 'Schlagwort', plural: 'Schlagwörter' },
  admin: { useAsTitle: 'name', group: 'Archiv' },
  access: { read: authenticated, create: isKuratorOrAdmin, update: isKuratorOrAdmin, delete: isAdmin },
  fields: [{ name: 'name', type: 'text', required: true, unique: true, label: 'Name' }],
}
