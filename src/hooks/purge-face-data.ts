import type { CollectionAfterChangeHook, CollectionAfterDeleteHook, PayloadRequest } from 'payload'

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
  const result = await req.payload.delete({
    collection: 'face-suggestions',
    where: { suggestedPerson: { equals: personId } },
    overrideAccess: true,
    req,
  })
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

export const purgeFaceDataForDeletedPerson: CollectionAfterDeleteHook = async ({ req, id }) => {
  // No beforeDelete capture needed here, unlike sync-hidden-photos: face-suggestions rows point
  // at the PERSON by id, and we have that id right here on the hook's own arguments.
  await purgeFaceDataForPerson(req, id)
}
