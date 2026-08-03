import type { CollectionAfterChangeHook } from 'payload'

// When a person's hidden flag flips, recompute hasHiddenPerson on all photos tagging them.
export const syncHiddenPhotos: CollectionAfterChangeHook = async ({ doc, previousDoc, req }) => {
  if (previousDoc && doc.hidden === previousDoc.hidden) return
  // Pass `req` through to every local API call below so they join the same DB
  // transaction as this hook. Without it, a nested query runs in its own
  // transaction and (under read-committed isolation) cannot see the person's
  // just-written, not-yet-committed `hidden` flag.
  const photos = await req.payload.find({
    collection: 'photos',
    // `in` is the documented relationship-field operator; `contains` is a text/LIKE operator
    // that happens to also match here under the current adapter but isn't guaranteed to on
    // another one — this is the central hidden-person control, so use the correct operator.
    where: { people: { in: [doc.id] } },
    limit: 0,
    pagination: false,
    overrideAccess: true,
    depth: 0,
    req,
  })
  for (const photo of photos.docs) {
    const ids = (photo.people ?? []) as (string | number)[]
    const hiddenLinked = await req.payload.find({
      collection: 'people',
      where: { and: [{ id: { in: ids } }, { hidden: { equals: true } }] },
      limit: 1,
      overrideAccess: true,
      req,
    })
    await req.payload.update({
      collection: 'photos',
      id: photo.id,
      data: { hasHiddenPerson: hiddenLinked.totalDocs > 0 },
      overrideAccess: true,
      depth: 0,
      req,
    })
  }
}
