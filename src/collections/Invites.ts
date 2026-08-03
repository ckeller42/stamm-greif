import type { CollectionConfig } from 'payload'
import { isAdmin } from '@/access/roles'
import crypto from 'crypto'

export const Invites: CollectionConfig = {
  slug: 'invites',
  admin: { useAsTitle: 'token', group: 'Verwaltung' },
  access: { read: isAdmin, create: isAdmin, update: isAdmin, delete: isAdmin },
  fields: [
    { name: 'token', type: 'text', required: true, unique: true, admin: { readOnly: true },
      defaultValue: () => crypto.randomUUID() },
    { name: 'role', type: 'select', required: true, defaultValue: 'mitglied',
      options: [{ label: 'Kurator', value: 'kurator' }, { label: 'Mitglied', value: 'mitglied' }] },
    { name: 'usedBy', type: 'relationship', relationTo: 'users', admin: { readOnly: true } },
    { name: 'expiresAt', type: 'date', label: 'Gültig bis' },
  ],
  endpoints: [
    {
      path: '/accept',
      method: 'post',
      handler: async (req) => {
        const { token, name, email, password } = (await req.json?.()) ?? {}
        if (!token || !name || !email || !password) {
          return Response.json({ error: 'Fehlende Angaben' }, { status: 400 })
        }
        const found = await req.payload.find({
          collection: 'invites', where: { token: { equals: token } }, overrideAccess: true,
        })
        const invite = found.docs[0]
        if (!invite) return Response.json({ error: 'Einladung nicht gefunden' }, { status: 404 })
        const expired = invite.expiresAt && new Date(invite.expiresAt) < new Date()
        if (invite.usedBy || expired) {
          return Response.json({ error: 'Einladung bereits verwendet oder abgelaufen' }, { status: 410 })
        }
        const user = await req.payload.create({
          collection: 'users',
          data: { name, email, password, role: invite.role },
          overrideAccess: true,
        })
        await req.payload.update({
          collection: 'invites', id: invite.id, data: { usedBy: user.id }, overrideAccess: true,
        })
        return Response.json({ ok: true })
      },
    },
  ],
}
