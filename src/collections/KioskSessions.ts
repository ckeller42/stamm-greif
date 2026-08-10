import type { CollectionConfig } from 'payload'
import { isAdmin } from '@/access/roles'

// P2.4 — one row per minted kiosk link. This is the revocation + audit story: a signed kiosk/
// download token embeds this row's id (`sid`); every kiosk request loads the row and rejects if
// it is missing, `revokedAt` is set, or `expiresAt` has passed. Revoke = one field write, no
// secret rotation, no member-login impact. Admin-only CRUD (same posture as Invites); kurators
// mint/revoke through /api/kiosk/session, which runs overrideAccess:true.
export const KioskSessions: CollectionConfig = {
  slug: 'kiosk-sessions',
  labels: { singular: 'Kiosk-Sitzung', plural: 'Kiosk-Sitzungen' },
  admin: { useAsTitle: 'label', group: 'Verwaltung', defaultColumns: ['label', 'expiresAt', 'revokedAt'] },
  access: { read: isAdmin, create: isAdmin, update: isAdmin, delete: isAdmin },
  fields: [
    { name: 'label', type: 'text', label: 'Bezeichnung' },
    { name: 'expiresAt', type: 'date', required: true, label: 'Gültig bis' },
    { name: 'revokedAt', type: 'date', label: 'Widerrufen am', admin: { readOnly: true } },
    {
      name: 'createdBy',
      type: 'relationship',
      relationTo: 'users',
      admin: { readOnly: true },
      access: { update: () => false },
    },
  ],
}
