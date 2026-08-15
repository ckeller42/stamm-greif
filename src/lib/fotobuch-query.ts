import type { Payload, Where } from 'payload'
import type { Photo } from '@/payload-types'

// The exact, narrow shape the durable PDF export is allowed to carry (Task 5's hardening review,
// defense-in-depth): the underlying `find` is overrideAccess:true, so it bypasses field-level
// access control too — without an explicit `select`, the returned docs would carry exifLat/
// exifLng (member home GPS, kurator/admin-only elsewhere), phash, exifTakenAt etc. straight into
// a file that leaves the system. `select` (below) is what actually enforces this; this type is
// its accurate TypeScript mirror, not a superset cast of the full generated `Photo`.
export type FotobuchPhoto = Pick<
  Photo,
  'id' | 'caption' | 'datePrecision' | 'dateValue' | 'dateSortKey' | 'filename' | 'sizes'
>

const FOTOBUCH_PHOTO_SELECT = {
  caption: true,
  datePrecision: true,
  dateValue: true,
  dateSortKey: true,
  filename: true,
  sizes: true,
} as const

// A single event/series/person book is bounded to dozens–low-hundreds of photos; this cap bounds
// worst-case render work and memory so generation stays a safe synchronous request (spec §6.5).
// A module constant, not an env var, deliberately — keeps .env stable (a stated non-goal).
export const FOTOBUCH_MAX_PHOTOS = 300

export type FotobuchTargetType = 'event' | 'series' | 'person'

// Thrown by collectFotobuchPhotos() when a PERSON-subject book is requested for a person whose
// consent has been withdrawn (People.hidden === true). This is the builder's clean refusal signal
// (spec §3): the endpoint (Task 5) catches this and maps it to HTTP 403 — a hidden person's photos
// must never be assembled into a durable file, not even an empty one that silently "succeeds".
// A dedicated error type (not a generic Error/thrown string) so the endpoint can distinguish this
// from any other failure via `instanceof` rather than message-sniffing.
export class FotobuchHiddenPersonError extends Error {
  constructor(personId: number) {
    super(`fotobuch refused: person ${personId} is hidden`)
    this.name = 'FotobuchHiddenPersonError'
  }
}

// THE consent filter for the durable PDF export (spec §3). Direct sibling of kioskPhotoWhere():
// the SAME AND-terms MINUS the kiosk allowlist. The PDF leaves the system, so it gets the same
// consent bar as any shared surface — and, unlike the app's own views, it holds even for a
// kurator (whose canReadPhoto returns true and would otherwise leak hidden-person photos into the
// file). Imported ONLY through collectFotobuchPhotos below; never inline this `where`.
//
//   _status == 'published'     never a draft
//   hasHiddenPerson != true    never a hidden-person photo — nothing can override this
//   deletedAt not exists       never a binned photo
export function fotobuchPhotoWhere(): Where {
  return {
    and: [
      { _status: { equals: 'published' } },
      { hasHiddenPerson: { not_equals: true } },
      { deletedAt: { exists: false } },
    ],
  }
}

/**
 * The consent-filtered, ordered, capped photo set a book is built from (spec §3, §6.1).
 *
 * - `overrideAccess: true` is REQUIRED and safe ONLY because fotobuchPhotoWhere() reconstructs the
 *   full consent filter — the same posture the kiosk uses, for the same reason (a kurator's
 *   canReadPhoto short-circuits to `true` and must not decide what enters a durable file).
 * - `excludeIds` is subtracted in code AFTER the query — it can only REMOVE. It is never merged
 *   into the `where`, so it can never re-admit a hidden-person / draft / binned photo.
 * - Ordered oldest→newest, `dateSortKey` then `id` as a deterministic tiebreaker — photos routinely
 *   share a fuzzy dateSortKey (year/decade precision), and without a secondary key Postgres orders
 *   ties arbitrarily, making both the 300-cap boundary and the cover-photo pick (first of the
 *   result) nondeterministic across otherwise-identical requests.
 * - For a PERSON subject whose consent has been withdrawn (People.hidden === true), the whole book
 *   is refused (FotobuchHiddenPersonError) rather than silently returning an (empty-looking, or
 *   partially-populated from stale references) photo set — see the class doc above.
 * - Returns only `FotobuchPhoto`'s narrow field set (see its doc above) via an explicit `select` —
 *   NOT the full `Photo` shape, deliberately, even though the query runs overrideAccess:true.
 */
export async function collectFotobuchPhotos(
  payload: Payload,
  args: { type: FotobuchTargetType; id: number; excludeIds?: number[] },
): Promise<FotobuchPhoto[]> {
  const { type, id, excludeIds = [] } = args

  let subject: Where
  if (type === 'event') {
    subject = { event: { equals: id } }
  } else if (type === 'person') {
    // A missing person id is left to fall through to the ordinary query below (which will
    // naturally yield an empty set, like an event/series with no photos) — only an EXISTING,
    // explicitly hidden person triggers the refusal. Conflating "not found" with "hidden" would
    // blur the endpoint's 404-vs-403 distinction and isn't what consent withdrawal means.
    const person = await payload.findByID({
      collection: 'people',
      id,
      depth: 0,
      overrideAccess: true,
      disableErrors: true,
    })
    if (person?.hidden) throw new FotobuchHiddenPersonError(id)
    // `in` is the documented relationship-field operator (see src/hooks/sync-hidden-photos.ts's
    // photoIdsOfPerson, the central hidden-person control this mirrors): `contains` is a text/LIKE
    // operator that happens to also match here under the current adapter but isn't guaranteed to
    // on another one. This IS the load-bearing consent artifact, so it uses the same operator.
    subject = { people: { in: [id] } }
  } else {
    // Series: photos are linked to a single `event`, not to a series directly — so resolve the
    // series' events first, then photos whose event is one of them. Two explicit steps rather than
    // a nested relationship query, so the shape is obvious and deterministic.
    const events = await payload.find({
      collection: 'events',
      where: { series: { equals: id } },
      select: {},
      pagination: false,
      depth: 0,
      overrideAccess: true,
    })
    const eventIds = events.docs.map((e) => e.id)
    if (eventIds.length === 0) return []
    subject = { event: { in: eventIds } }
  }

  const res = await payload.find({
    collection: 'photos',
    where: { and: [subject, fotobuchPhotoWhere()] },
    sort: ['dateSortKey', 'id'], // ascending — oldest first, id as a deterministic tiebreaker
    limit: FOTOBUCH_MAX_PHOTOS,
    depth: 0, // relations stay as bare ids — fine, FotobuchPhoto has none of them selected anyway
    select: FOTOBUCH_PHOTO_SELECT,
    overrideAccess: true,
  })

  const exclude = new Set(excludeIds.map(String))
  return res.docs.filter((p) => !exclude.has(String(p.id))) as FotobuchPhoto[]
}
