import type { CollectionConfig } from 'payload'
import { authenticated, isAdmin, isKuratorOrAdmin } from '@/access/roles'

export const People: CollectionConfig = {
  slug: 'people',
  labels: { singular: 'Person', plural: 'Personen' },
  admin: { useAsTitle: 'name', group: 'Archiv' },
  access: { read: authenticated, create: isKuratorOrAdmin, update: isKuratorOrAdmin, delete: isAdmin },
  fields: [
    { name: 'name', type: 'text', required: true, label: 'Name' },
    { name: 'bio', type: 'textarea', label: 'Notizen / Biografie' },
    { name: 'birthYear', type: 'number', label: 'Geburtsjahr' },
    { name: 'hidden', type: 'checkbox', defaultValue: false, label: 'Person verbergen (Einwilligung widerrufen)' },
  ],
}
