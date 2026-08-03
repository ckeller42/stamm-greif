import type { CollectionConfig } from 'payload'
import { authenticated, isAdmin, isKuratorOrAdmin } from '@/access/roles'

export const Memberships: CollectionConfig = {
  slug: 'memberships',
  labels: { singular: 'Mitgliedschaft', plural: 'Mitgliedschaften' },
  admin: { group: 'Archiv' },
  access: { read: authenticated, create: isKuratorOrAdmin, update: isKuratorOrAdmin, delete: isAdmin },
  fields: [
    { name: 'person', type: 'relationship', relationTo: 'people', required: true, label: 'Person' },
    { name: 'group', type: 'relationship', relationTo: 'groups', required: true, label: 'Gruppe' },
    { name: 'vonYear', type: 'number', label: 'Von (Jahr)' },
    { name: 'bisYear', type: 'number', label: 'Bis (Jahr)' },
    { name: 'role', type: 'select', required: true, defaultValue: 'mitglied', label: 'Rolle',
      options: [
        { label: 'Mitglied', value: 'mitglied' },
        { label: 'Sippenführer', value: 'sippenfuehrer' },
        { label: 'Leiter', value: 'leiter' },
      ] },
  ],
}
