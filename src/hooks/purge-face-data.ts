import type { CollectionAfterChangeHook, CollectionBeforeDeleteHook, PayloadRequest } from 'payload'

// P2.3 consent coupling. `people.hidden` („Person verbergen (Einwilligung widerrufen)") is the
// single consent boundary for face data too: flipping it on hard-deletes every face-suggestions
// row naming that person, whatever its status — an `offen` row names them, a `bestaetigt` row
// names them AND holds their biometric template, an `abgelehnt` row still names them.
//
// This runs in the same DB transaction as the flag change itself, so withdrawal and purge cannot
// come apart. IRREVERSIBLE: un-setting `hidden` restores nothing. The person is simply tagged by
// hand again until a kurator confirms a new suggestion, which re-indexes them from scratch.
export async function purgeFaceDataForPerson(
  req: PayloadRequest,
  personId: string | number,
): Promise<number> {
  // Review (Task 6, round 2): forced-failure injection for the rollback regression test — proves
  // the "cannot come apart" guarantee above actually holds (a single-doc `hidden: true` update
  // rolls back its whole transaction, not just skips the purge) rather than asserting it in a
  // comment nobody re-checks. Gated on an env var no real deployment would ever set.
  if (process.env.FACES_TEST_FORCE_PURGE_FAILURE === '1') {
    throw new Error('FACES_TEST_FORCE_PURGE_FAILURE: synthetic purge failure for rollback testing')
  }
  const result = await req.payload.delete({
    collection: 'face-suggestions',
    where: { suggestedPerson: { equals: personId } },
    overrideAccess: true,
    req,
  })
  // Review (Task 6, round 2), H1: a bulk `delete({ where })` never rejects on a per-row failure —
  // it resolves with that row's error pushed onto `result.errors` while every OTHER row still
  // gets deleted. Reading only `result.docs.length` (the original code here) silently treats a
  // partial purge as a full one: the caller — the `hidden: true` afterChange hook below, in the
  // SAME transaction — would then return normally and let that transaction commit, leaving the
  // person marked hidden while a face-suggestions row (biometric template included) survives.
  // Throwing here is what actually makes "withdrawal and purge cannot come apart" true: it
  // propagates out of the afterChange/beforeDelete hook and aborts the whole transaction.
  if (result.errors.length > 0) {
    throw new Error(
      `face-data-purge-incomplete: ${result.errors.length} face-suggestions row(s) for person ` +
        `${personId} failed to delete: ${result.errors.map((e) => e.message).join('; ')}`,
    )
  }
  const deleted = result.docs.length
  if (deleted > 0) {
    req.payload.logger.info({ msg: 'face-data-purged', personId, deleted })
  }
  return deleted
}

export const purgeFaceDataForHiddenPerson: CollectionAfterChangeHook = async ({ doc, previousDoc, req }) => {
  // Same guard shape as syncHiddenPhotos: only act on the false→true transition.
  if (!doc.hidden || previousDoc?.hidden === true) return
  await purgeFaceDataForPerson(req, doc.id)
}

// Review (Task 6, round 2), C1: a HARD DELETE of a person is exactly the same "FK action fires
// inside the DELETE statement, before any JS-level hook runs" trap Photos.ts's
// deleteFaceSuggestionsBeforePhotoDelete was written to close for photos — except this one was
// missed here. face_suggestions.suggested_person_id is `ON DELETE set null` (in EVERY deploy
// mode; this FK was never hand-edited to cascade the way photo_id was — see the face_suggestions
// migration). By the time an `afterDelete` hook runs, Postgres has already nulled out
// `suggested_person_id` on every row that named this person, so a `where: { suggestedPerson:
// { equals: personId } }` query — this hook's ONLY way of finding those rows — matches nothing.
// The row (and, for a `bestaetigt` one, its embedding) survives forever: not purged, not visible
// to a `suggestedPerson`-based query, unreachable by reconcileHiddenFaceData (same query shape)
// and untouched by the 180-day sweep (which only ever looks at `offen` rows). `beforeDelete` is
// what actually closes it — same fix shape as Photos, verified against Payload's own internal
// `deleteSubfoldersBeforeDelete` hook (folders/hooks/deleteSubfoldersAfterDelete.ts, despite its
// filename) for the identical cascade-before-parent-delete need.
export const purgeFaceDataForDeletedPerson: CollectionBeforeDeleteHook = async ({ req, id }) => {
  await purgeFaceDataForPerson(req, id)
}
