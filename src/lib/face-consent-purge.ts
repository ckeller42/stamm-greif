import type { PayloadRequest } from 'payload'

// Minimal shape of the photo fields this consent check reads. Kept local (rather than importing
// detectFaces' PhotoLike) so this helper does NOT pull in the onnxruntime/face-model import chain —
// it must stay unit-testable without loading any WASM.
export type PhotoConsentState = {
  hasHiddenPerson?: boolean | null
  deletedAt?: string | null
  _status?: string | null
}

/**
 * C3 (consent audit): close the TOCTOU between detectFaces' opening guard and its suggestion
 * writes. A person can be marked hidden — and purgeFaceDataForHiddenPerson can run and find
 * nothing — while inference (hundreds of ms of WASM) is in flight, after which detectFaces creates
 * fresh `offen` rows carrying that person's biometric embedding for a photo whose consent was
 * withdrawn.
 *
 * After writing, re-read the photo's consent state and, if it flipped to hidden/binned/unpublished,
 * delete this photo's `offen` rows — exactly the rows just written (pre-existing ones were cleared
 * at the top of the handler, and the exclusive per-photo concurrencyKey means no other detectFaces
 * run for this photo is interleaving). Either the hide's purge hook sees our rows or this re-check
 * does; no embedding survives on a hidden or binned photo. Returns true if it purged, so the caller
 * reports a suggestionCount of 0.
 */
export async function purgeSuggestionsIfConsentWithdrawn(
  req: PayloadRequest,
  photoId: string | number,
  writtenCount: number,
  suggestedPersonIds: Array<number | string> = [],
): Promise<boolean> {
  if (writtenCount <= 0) return false
  const after = (await req.payload.findByID({
    collection: 'photos',
    id: photoId,
    overrideAccess: true,
    disableErrors: true,
    depth: 0,
    req,
  })) as PhotoConsentState | null
  if (after && !after.hasHiddenPerson && !after.deletedAt && after._status === 'published') {
    // The photo itself is still fine, but a row just written can NAME a hidden person via an
    // embedding match (suggestedPerson) on a photo where that person is not tagged — so the
    // photo-level flags above never flip. detectFaces excludes hidden people from its match index,
    // but only as of when the index was built; a person hidden DURING inference can still be
    // matched. Outside this few-ms window purgeFaceDataForHiddenPerson's suggestedPerson branch
    // handles it; this closes the concurrent-overlap gap so a biometric embedding never outlives
    // consent. Scoped to the ids actually suggested THIS run so it costs nothing when no embedding
    // matched a person (the common case) — never a full-table scan on the detection hot path.
    await purgeOpenSuggestionsNamingHiddenPeople(req, photoId, suggestedPersonIds)
    return false
  }
  await req.payload.delete({
    collection: 'face-suggestions',
    where: { and: [{ photo: { equals: photoId } }, { status: { equals: 'offen' } }] },
    overrideAccess: true,
    req,
  })
  req.payload.logger.info({ msg: 'face-detect-consent-race-purged', photoId, purged: writtenCount })
  return true
}

async function purgeOpenSuggestionsNamingHiddenPeople(
  req: PayloadRequest,
  photoId: string | number,
  suggestedPersonIds: Array<number | string>,
): Promise<void> {
  const unique = [...new Set(suggestedPersonIds)]
  if (unique.length === 0) return
  // Only the just-suggested people that turned hidden — a small, id-scoped query, not a scan.
  const hidden = await req.payload.find({
    collection: 'people',
    where: { and: [{ id: { in: unique } }, { hidden: { equals: true } }] },
    limit: 0,
    pagination: false,
    overrideAccess: true,
    depth: 0,
    req,
  })
  const hiddenIds = hidden.docs.map((p: { id: number | string }) => p.id)
  if (hiddenIds.length === 0) return
  const purged = await req.payload.delete({
    collection: 'face-suggestions',
    where: {
      and: [
        { photo: { equals: photoId } },
        { status: { equals: 'offen' } },
        { suggestedPerson: { in: hiddenIds } },
      ],
    },
    overrideAccess: true,
    req,
  })
  const count = Array.isArray(purged?.docs) ? purged.docs.length : 0
  if (count > 0) {
    req.payload.logger.info({ msg: 'face-detect-consent-race-purged-suggested', photoId, purged: count })
  }
}
