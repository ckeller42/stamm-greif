import '@/styles/theme.css'
import Link from 'next/link'
import { de } from '@/messages/de'
import { getUser } from '@/lib/get-user'
import { LogoutLink } from '@/components/logout-link'

export const metadata = { title: de.siteName, robots: { index: false, follow: false } }
// Every page under this layout reads the session via getUser(), so it must never be statically
// prerendered/cached — force-dynamic also lets `next build` skip executing this tree at build
// time (avoiding a real DB connection during the Docker build), see docs/betrieb.md.
export const dynamic = 'force-dynamic'

export default async function FrontendLayout({ children }: { children: React.ReactNode }) {
  const user = await getUser()
  return (
    <html lang="de">
      <body>
        <header style={{ display: 'flex', gap: '1rem', padding: '1rem', alignItems: 'center' }}>
          <strong style={{ color: 'var(--gold)' }}>{de.siteName}</strong>
          {user && <Link href="/">{de.nav.archiv}</Link>}
          {user && <Link href="/hochladen">{de.nav.hochladen}</Link>}
          {user && (user.role === 'admin' || user.role === 'kurator') && (
            <Link href="/gesichter">{de.nav.gesichter}</Link>
          )}
          {user
            ? <LogoutLink>{de.nav.abmelden}</LogoutLink>
            : <Link href="/anmelden">{de.nav.anmelden}</Link>}
        </header>
        <main style={{ padding: '1rem' }}>{children}</main>
      </body>
    </html>
  )
}
