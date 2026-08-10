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

// Final review, M2: a photo can have MULTIPLE detected faces of the same person (e.g. a mirror,
// a photo-of-a-photo, or simply two crops a kurator confirmed separately) — each gets its own
// face-suggestions row, but `photos.people` only tags the person once. Un-confirming ONE such row
// (via undo or a reject-after-confirm) must not untag the person from the photo while another
// `bestaetigt` row still vouches for them there; the ORIGINAL unconditional
// `removePersonFromPhoto` call (both here and in `zuruecksetzen` before this fix) would do exactly
// that. `excludeSuggestionId` is the row being un-confirmed itself, so it doesn't count as its own
// "other" witness.
async function untagPersonIfNoOtherConfirmedRow(
  req: PayloadRequest,
  photoId: string | number,
  personId: string | number,
  excludeSuggestionId: string | number,
) {
  const otherConfirmed = await req.payload.find({
    collection: 'face-suggestions',
    where: {
      and: [
        { photo: { equals: photoId } },
        { suggestedPerson: { equals: personId } },
        { status: { equals: 'bestaetigt' } },
        { id: { not_equals: excludeSuggestionId } },
      ],
    },
    limit: 1,
    pagination: false,
    overrideAccess: true,
    depth: 0,
    req,
  })
  if (otherConfirmed.totalDocs === 0) {
    await removePersonFromPhoto(req, photoId, personId)
  }
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
        // Final review, L8: the sibling endpoints (bestaetigen, zuruecksetzen) both check
        // existence first and return the same `{ error: 'Nicht gefunden' }` 404 shape — this one
        // didn't, so rejecting a nonexistent/already-deleted id fell straight through to
        // Payload's own NotFound error instead, a differently-shaped response the frontend's
        // shared error handling (FaceReviewForm's `body?.error` read) doesn't expect.
        const suggestion = await req.payload
          .findByID({ collection: 'face-suggestions', id, overrideAccess: true, depth: 0, req })
          .catch(() => null)
        if (!suggestion) return Response.json({ error: 'Nicht gefunden' }, { status: 404 })
        // Final review, L8: rejecting a row that was previously `bestaetigt` (a kurator changing
        // their mind via "Ablehnen" instead of "Rückgängig") used to leave the person tagged on
        // the photo forever — only `zuruecksetzen` ever called removePersonFromPhoto. Mirrors that
        // endpoint's own guarded untag (M2): don't remove the tag if another confirmed row on the
        // same photo still names the same person.
        if (suggestion.suggestedPerson) {
          await untagPersonIfNoOtherConfirmedRow(
            req,
            suggestion.photo as string | number,
            suggestion.suggestedPerson as string | number,
            id,
          )
        }
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
        // Final review, M2: was an unconditional removePersonFromPhoto — wrong whenever a SECOND
        // face on the same photo is also confirmed to this person (a mirror, a photo-of-a-photo,
        // two separately-confirmed crops): undoing one row untagged the person even though
        // another `bestaetigt` row still vouches for them on that exact photo.
        if (suggestion.suggestedPerson) {
          await untagPersonIfNoOtherConfirmedRow(
            req,
            suggestion.photo as string | number,
            suggestion.suggestedPerson as string | number,
            id,
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
