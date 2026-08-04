'use client'
import { useRouter } from 'next/navigation'

// Payload only registers POST for /api/users/logout (GET falls through to the
// generic findByID REST route and 500s). A plain <a href> can't do a POST, so
// this tiny client component does the fetch and redirects afterwards.
export function LogoutLink({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  async function logout() {
    try {
      await fetch('/api/users/logout', { method: 'POST' })
    } catch {
      // Network failure logging out — still clear the client-side view by
      // redirecting; the server-side cookie may or may not have been
      // cleared, but leaving the user stuck on a stale page is worse.
    }
    router.push('/')
    router.refresh()
  }
  return (
    // Not page navigation: onClick always preventDefaults and POSTs via fetch (see above). The
    // href is the POST target for readers; a GET on it would 500, so next/link is wrong here.
    // eslint-disable-next-line @next/next/no-html-link-for-pages
    <a href="/api/users/logout" onClick={(e) => { e.preventDefault(); void logout() }}>
      {children}
    </a>
  )
}
