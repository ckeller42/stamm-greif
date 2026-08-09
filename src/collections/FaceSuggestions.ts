import type { CollectionConfig, PayloadRequest } from 'payload'
import { isKuratorOrAdmin } from '@/access/roles'

const isModerator = (req: PayloadRequest): boolean =>
  req.user?.role === 'admin' || req.user?.role === 'kurator'

// Tagging goes through payload.update with the same `req`, so Photos' existing beforeChange hook
// recomputes hasHiddenPerson in the same transaction — no hidden-person logic is duplicated here.
async function addPersonToPhoto(req: PayloadRequest, photoId: string | number, personId: string | number) {
  const photo = await req.payload.findByID({
    collection: 'photos', id: Number(photoId), overrideAccess: true, depth: 0, req,
  })
  const current = ((photo.people ?? []) as (number | { id: number })[]).map((p) =>
    typeof p === 'object' ? p.id : p,
  )
  if (current.map(String).includes(String(personId))) return
  await req.payload.update({
    collection: 'photos',
    id: Number(photoId),
    data: { people: [...current, Number(personId)] },
    overrideAccess: true,
    depth: 0,
    req,
  })
}

async function removePersonFromPhoto(req: PayloadRequest, photoId: string | number, personId: string | number) {
  const photo = await req.payload.findByID({
    collection: 'photos', id: Number(photoId), overrideAccess: true, depth: 0, req,
  })
  const current = ((photo.people ?? []) as (number | { id: number })[]).map((p) =>
    typeof p === 'object' ? p.id : p,
  )
  const next = current.filter((p) => String(p) !== String(personId))
  if (next.length === current.length) return
  await req.payload.update({
    collection: 'photos', id: Number(photoId), data: { people: next }, overrideAccess: true, depth: 0, req,
  })
}

// P2.3 face detection. One row per detected face. The row is created by the detectFaces job with
// its embedding already computed, so confirming later performs no inference at all — it only
// flips `status` and tags the person.
//
// Access is kurator/admin at the collection level, and `embedding` is additionally unreadable by
// ANYONE through the API (access.read: () => false): no UI needs it, and a field no response can
// carry cannot leak through one. The job and the endpoints read it via overrideAccess.
export const FaceSuggestions: CollectionConfig = {
  slug: 'face-suggestions',
  labels: { singular: 'Gesichts-Vorschlag', plural: 'Gesichts-Vorschläge' },
  admin: { group: 'Archiv', defaultColumns: ['photo', 'suggestedPerson', 'status', 'similarity'] },
  access: {
    read: isKuratorOrAdmin,
    create: isKuratorOrAdmin,
    update: isKuratorOrAdmin,
    delete: isKuratorOrAdmin,
  },
  fields: [
    { name: 'photo', type: 'relationship', relationTo: 'photos', required: true, index: true, label: 'Foto' },
    // Normalised 0…1, not pixels: one row then crops correctly from thumbnail, web or original.
    { name: 'boxXMin', type: 'number', required: true },
    { name: 'boxYMin', type: 'number', required: true },
    { name: 'boxXMax', type: 'number', required: true },
    { name: 'boxYMax', type: 'number', required: true },
    { name: 'boxProbability', type: 'number', label: 'Erkennungssicherheit' },
    {
      name: 'embedding',
      type: 'json',
      label: 'Gesichtsmerkmal (biometrisch)',
      admin: { hidden: true },
      // Biometric data under Art. 9 DSGVO. Never leaves the server: no API response may carry
      // it, in either direction, for any role.
      access: { read: () => false, create: () => false, update: () => false },
    },
    { name: 'suggestedPerson', type: 'relationship', relationTo: 'people', index: true, label: 'Vorgeschlagene Person' },
    { name: 'similarity', type: 'number', label: 'Ähnlichkeit' },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'offen',
      index: true,
      label: 'Status',
      options: [
        { label: 'Offen', value: 'offen' },
        { label: 'Bestätigt', value: 'bestaetigt' },
        { label: 'Abgelehnt', value: 'abgelehnt' },
      ],
    },
    { name: 'confirmedBy', type: 'relationship', relationTo: 'users', admin: { readOnly: true }, label: 'Geprüft von' },
    { name: 'confirmedAt', type: 'date', admin: { readOnly: true }, label: 'Geprüft am' },
    { name: 'detectedAt', type: 'date', admin: { readOnly: true }, label: 'Erkannt am' },
    { name: 'sourceVariant', type: 'text', admin: { readOnly: true }, label: 'Quelle (Bildgröße)' },
  ],
  endpoints: [
    {
      path: '/:id/bestaetigen',
      method: 'post',
      handler: async (req) => {
        if (!isModerator(req)) return Response.json({ error: 'Nicht erlaubt' }, { status: 403 })
        const id = req.routeParams?.id as string
        const { personId } = (await req.json?.()) ?? {}
        if (!personId) return Response.json({ error: 'Person fehlt' }, { status: 400 })

        const suggestion = await req.payload
          .findByID({ collection: 'face-suggestions', id, overrideAccess: true, depth: 0, req })
          .catch(() => null)
        if (!suggestion) return Response.json({ error: 'Nicht gefunden' }, { status: 404 })

        const person = await req.payload
          .findByID({ collection: 'people', id: personId, overrideAccess: true, depth: 0, req })
          .catch(() => null)
        if (!person) return Response.json({ error: 'Person nicht gefunden' }, { status: 404 })
        // A person whose consent is withdrawn can never be re-indexed through this path.
        if (person.hidden) {
          return Response.json({ error: 'Diese Person ist verborgen.' }, { status: 409 })
        }

        await req.payload.update({
          collection: 'face-suggestions',
          id,
          data: {
            status: 'bestaetigt',
            suggestedPerson: personId,
            confirmedBy: req.user?.id ?? null,
            confirmedAt: new Date().toISOString(),
          },
          overrideAccess: true,
          req,
        })
        await addPersonToPhoto(req, suggestion.photo as string | number, personId)
        return Response.json({ ok: true })
      },
    },
    {
      path: '/:id/ablehnen',
      method: 'post',
      handler: async (req) => {
        if (!isModerator(req)) return Response.json({ error: 'Nicht erlaubt' }, { status: 403 })
        const id = req.routeParams?.id as string
        await req.payload.update({
          collection: 'face-suggestions',
          id,
          // Rejected means "not a face" or "not identifiable" — we do not train on negatives, so
          // the biometric payload goes immediately. The row survives only as a tombstone, so a
          // re-run's IoU check cannot resurrect the same box.
          data: {
            status: 'abgelehnt',
            embedding: null,
            confirmedBy: req.user?.id ?? null,
            confirmedAt: new Date().toISOString(),
          },
          overrideAccess: true,
          req,
        })
        return Response.json({ ok: true })
      },
    },
    {
      path: '/:id/zuruecksetzen',
      method: 'post',
      handler: async (req) => {
        if (!isModerator(req)) return Response.json({ error: 'Nicht erlaubt' }, { status: 403 })
        const id = req.routeParams?.id as string
        const suggestion = await req.payload
          .findByID({ collection: 'face-suggestions', id, overrideAccess: true, depth: 0, req })
          .catch(() => null)
        if (!suggestion) return Response.json({ error: 'Nicht gefunden' }, { status: 404 })
        if (suggestion.suggestedPerson) {
          await removePersonFromPhoto(
            req,
            suggestion.photo as string | number,
            suggestion.suggestedPerson as string | number,
          )
        }
        await req.payload.update({
          collection: 'face-suggestions',
          id,
          // The embedding stays: it is still a valid face, it is just no longer indexed to anyone
          // (the index is "confirmed AND names a person").
          data: { status: 'offen', confirmedBy: null, confirmedAt: null },
          overrideAccess: true,
          req,
        })
        return Response.json({ ok: true })
      },
    },
  ],
}
