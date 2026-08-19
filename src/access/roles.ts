import type { Access } from 'payload'

export const authenticated: Access = ({ req }) => Boolean(req.user)
export const isAdmin: Access = ({ req }) => req.user?.role === 'admin'
export const isKuratorOrAdmin: Access = ({ req }) =>
  req.user?.role === 'admin' || req.user?.role === 'kurator'
export const isAdminOrSelf: Access = ({ req, id }) =>
  req.user?.role === 'admin' || (req.user != null && String(req.user.id) === String(id))

// P2 consent audit, C2: a hidden person (consent withdrawn) must not be READABLE by ordinary
// members. Their PHOTOS are already suppressed by canReadPhoto, but their name and bio otherwise
// leak through the home-page people list, the FilterBar person dropdown, and any GET /api/people.
// Curators/admins keep full access — they manage the hidden state and the /gesichter review — while
// members get a filtered view and anonymous callers get nothing. Enforcing this in collection
// access closes the leak for every read path at once; the per-page guards (personen/[id],
// gesichter) remain as defence-in-depth.
export const canReadPerson: Access = ({ req: { user } }) => {
  if (!user) return false
  if (user.role === 'admin' || user.role === 'kurator') return true
  return { hidden: { not_equals: true } }
}
