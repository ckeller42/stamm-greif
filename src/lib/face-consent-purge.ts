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
