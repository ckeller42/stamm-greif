import type { Metadata } from 'next'

// P2.4 — root layout for the unauthenticated /kiosk surface. This route group sits alongside
// (frontend) and (payload), NOT nested under either, so it never runs (frontend)'s per-page
// getUser()+redirect('/anmelden') gate (see src/app/(frontend)/page.tsx) — the kiosk authenticates
// via its own signed link (verifyKioskToken + loadValidSession in the page below), not a user
// session, and deliberately never calls getUser() here. Its own <html>/<body>: a plain black
// canvas for the beamer, no nav, no theme.css.
export const metadata: Metadata = {
  title: 'Kiosk',
  robots: { index: false, follow: false },
}
// Every request re-verifies the link + re-runs the consent query, so this tree must never be
// statically prerendered/cached.
export const dynamic = 'force-dynamic'

export default function KioskLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="de">
      <body style={{ margin: 0, background: '#000', color: '#eee', minHeight: '100vh', overflow: 'hidden' }}>
        {children}
      </body>
    </html>
  )
}
