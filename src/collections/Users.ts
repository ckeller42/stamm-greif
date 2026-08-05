import type { CollectionConfig } from 'payload'
import { authenticated, isAdmin, isAdminOrSelf } from '@/access/roles'

export const Users: CollectionConfig = {
  slug: 'users',
  auth: true,
  admin: { useAsTitle: 'name' },
  access: {
    read: authenticated,
    create: isAdmin, // members are created via the invite endpoint (overrideAccess)
    update: isAdminOrSelf,
    delete: isAdmin,
    admin: ({ req }) => req.user?.role === 'admin' || req.user?.role === 'kurator',
  },
  fields: [
    { name: 'name', type: 'text', required: true, label: 'Name' },
    {
      name: 'role',
      type: 'select',
      required: true,
      defaultValue: 'mitglied',
      options: [
        { label: 'Admin', value: 'admin' },
        { label: 'Kurator', value: 'kurator' },
        { label: 'Mitglied', value: 'mitglied' },
      ],
      access: { update: ({ req }) => req.user?.role === 'admin' },
      saveToJWT: true,
    },
  ],
}
