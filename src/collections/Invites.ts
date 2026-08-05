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
        // Create the user first, then claim the invite with a single atomic conditional UPDATE.
        // The check-then-write above is only a fast/friendly path — it is NOT the guard: the
        // endpoint is unauthenticated, so an attacker holding one token can fire parallel POSTs
        // that all pass it before any writes `usedBy`. The real gate is the raw SQL below
        // (`... WHERE used_by_id IS NULL`): Postgres row-locks serialize the concurrent updates,
        // so exactly one matches and the rest see rowCount 0. We use raw SQL because Payload's
        // where-based update can resolve matching ids and then update by id — not atomic enough
        // to stop this race. A request that loses the race deletes the user it just created.
        const user = await req.payload.create({
          collection: 'users',
          data: { name, email, password, role: invite.role },
          overrideAccess: true,
        })
        const claim = await req.payload.db.pool.query(
          'UPDATE invites SET used_by_id = $1, updated_at = now() WHERE id = $2 AND used_by_id IS NULL RETURNING id',
          [user.id, invite.id],
        )
        if (claim.rowCount !== 1) {
          await req.payload.delete({ collection: 'users', id: user.id, overrideAccess: true })
          return Response.json({ error: 'Einladung bereits verwendet oder abgelaufen' }, { status: 410 })
        }
        return Response.json({ ok: true })
      },
    },
  ],
}
