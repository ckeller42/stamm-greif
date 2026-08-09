// Pure purge-window logic for the Papierkorb auto-purge (spec P2.1-B). The actual DB delete
// lives in src/jobs/purgePapierkorb.ts (needs a live `payload` instance); this module is just
// "how old is too old", kept separate so it's unit-testable without a database.
export const PURGE_WINDOW_DAYS = 30

// Everything soft-deleted at or before this instant is due for hard purge.
export function purgeCutoff(now: Date = new Date(), windowDays: number = PURGE_WINDOW_DAYS): Date {
  return new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000)
}

export function isDueForPurge(
  deletedAt: string | Date | null | undefined,
  now: Date = new Date(),
  windowDays: number = PURGE_WINDOW_DAYS,
): boolean {
  if (!deletedAt) return false
  const d = deletedAt instanceof Date ? deletedAt : new Date(deletedAt)
  if (Number.isNaN(d.getTime())) return false
  return d.getTime() <= purgeCutoff(now, windowDays).getTime()
}
