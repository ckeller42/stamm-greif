'use client'
import { useRouter } from 'next/navigation'

// Payload only registers POST for /api/users/logout (GET falls through to the
// generic findByID REST route and 500s). A plain <a href> can't do a POST, so
// this tiny client component does the fetch and redirects afterwards.
export function LogoutLink({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  async function logout() {
    await fetch('/api/users/logout', { method: 'POST' })
    router.push('/')
    router.refresh()
  }
  return (
    <a href="/api/users/logout" onClick={(e) => { e.preventDefault(); void logout() }}>
      {children}
    </a>
  )
}
