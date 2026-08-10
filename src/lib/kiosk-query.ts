import type { Where } from 'payload'

// P2.4 — THE consent filter for every unauthenticated kiosk surface (spec §3). The kiosk runs its
// photo queries with overrideAccess:true (there is no req.user, so canReadPhoto would return
// false and show nothing), which means the collection's own access control is deliberately
// bypassed — and this is the ONLY thing that keeps that safe. Every AND term here mirrors the
// "published" branch of canReadPhoto in src/collections/Photos.ts, PLUS the kiosk allowlist:
//
//   kioskFreigegeben == true   the curator's explicit opt-in (the human consent gate)
//   _status == 'published'     never a draft
//   hasHiddenPerson != true    never a hidden-person photo — the allowlist can't override this
//   deletedAt not exists       never a binned photo
//
// The allowlist is only ever an EXTRA restriction: it appears here inside an AND, never an OR.
// Imported by BOTH the /kiosk slideshow fetch and the /api/kiosk/download re-check so the two can
// never drift — do not inline this `where` anywhere. Changing it changes what the public beamer
// can show; the int tests in tests/int/kiosk.int.test.ts pin the safety property against it.
export function kioskPhotoWhere(): Where {
  return {
    and: [
      { kioskFreigegeben: { equals: true } },
      { _status: { equals: 'published' } },
      { hasHiddenPerson: { not_equals: true } },
      { deletedAt: { exists: false } },
    ],
  }
}
