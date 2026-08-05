import type {
  CollectionAfterChangeHook,
  CollectionAfterDeleteHook,
  CollectionBeforeDeleteHook,
  PayloadRequest,
} from 'payload'

// Recompute hasHiddenPerson for one photo from its currently-linked people. Callers pass `req`
// so every query joins the same DB transaction and sees not-yet-committed writes (the person's
// flipped `hidden` flag, or the cascade that just unlinked a deleted person).
async function recomputePhoto(req: PayloadRequest, photoId: string | number) {
  const photo = await req.payload.findByID({
    collection: 'photos', id: photoId, overrideAccess: true, depth: 0, req,
  })
  const ids = (photo.people ?? []) as (string | number)[]
  const hiddenLinked = ids.length
    ? await req.payload.find({
        collection: 'people',
        where: { and: [{ id: { in: ids } }, { hidden: { equals: true } }] },
        limit: 1, overrideAccess: true, req,
      })
    : { totalDocs: 0 }
  await req.payload.update({
    collection: 'photos', id: photoId,
    data: { hasHiddenPerson: hiddenLinked.totalDocs > 0 },
    overrideAccess: true, depth: 0, req,
  })
}

async function photoIdsOfPerson(req: PayloadRequest, personId: string | number) {
  const photos = await req.payload.find({
    collection: 'photos',
    // `in` is the documented relationship-field operator; `contains` is a text/LIKE operator
    // that happens to also match here under the current adapter but isn't guaranteed to on
    // another one — this is the central hidden-person control, so use the correct operator.
    where: { people: { in: [personId] } },
    limit: 0, pagination: false, overrideAccess: true, depth: 0, req,
  })
  return photos.docs.map((p) => p.id)
}

// When a person's hidden flag flips, recompute hasHiddenPerson on all photos tagging them.
export const syncHiddenPhotos: CollectionAfterChangeHook = async ({ doc, previousDoc, req }) => {
  if (previousDoc && doc.hidden === previousDoc.hidden) return
  for (const id of await photoIdsOfPerson(req, doc.id)) await recomputePhoto(req, id)
}

// Hard-deleting a person cascades (ON DELETE) their rows out of photos_rels, so by afterDelete
// the link is already gone and the affected photos can't be found by person id. Capture them
// here first, before the delete removes the relationships.
const CONTEXT_KEY = 'hiddenSyncPhotoIds'

export const captureHiddenPhotosBeforePersonDelete: CollectionBeforeDeleteHook = async ({ req, id }) => {
  const store = (req.context[CONTEXT_KEY] ??= {}) as Record<string, (string | number)[]>
  store[String(id)] = await photoIdsOfPerson(req, id)
}

// After the person (and their photo links) are gone, recompute the captured photos: if no other
// hidden person remains on a photo, hasHiddenPerson clears and the photo becomes visible again.
export const recomputeHiddenPhotosAfterPersonDelete: CollectionAfterDeleteHook = async ({ req, id }) => {
  const store = req.context[CONTEXT_KEY] as Record<string, (string | number)[]> | undefined
  for (const photoId of store?.[String(id)] ?? []) await recomputePhoto(req, photoId)
}
