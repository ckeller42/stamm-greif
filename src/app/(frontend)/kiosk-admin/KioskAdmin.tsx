'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { de } from '@/messages/de'
import { formatServerError } from '@/lib/server-error'
import { qrSvg } from '@/lib/qr'

type Session = { id: string; label: string; expiresAt: string }
type Minted = { url: string; expiresAt: string }

// /api/kiosk/session is a hand-written route (not a Payload collection endpoint), so its error
// body is `{ error: string }`, not the Payload REST `{ errors: [{ message }] }` shape
// formatServerError parses — try that first (keeping the house helper as the primary path per
// convention) and fall back to the route's own `error` field before the generic message.
function errorMessage(json: unknown): string {
  const fromPayloadShape = formatServerError(json)
  if (fromPayloadShape) return fromPayloadShape
  if (typeof json === 'object' && json !== null) {
    const err = (json as { error?: unknown }).error
    if (typeof err === 'string' && err.length > 0) return err
  }
  return de.kioskAdmin.error
}

export function KioskAdmin({ sessions, defaultHours }: { sessions: Session[]; defaultHours: number }) {
  const router = useRouter()
  const [label, setLabel] = useState('')
  const [hours, setHours] = useState(String(defaultHours))
  const [minting, setMinting] = useState(false)
  const [mintError, setMintError] = useState<string | null>(null)
  const [minted, setMinted] = useState<Minted | null>(null)
  const [copied, setCopied] = useState(false)
  // Same reentrancy trick as UploadForm.uploadingRef: a ref is read/written synchronously, so the
  // very first line of the handler sees the true current state even if two clicks land in the
  // same task before React's batched setMinting(true) has re-rendered the (disabled) button.
  const mintingRef = useRef(false)

  const [revokingId, setRevokingId] = useState<string | null>(null)
  const [revokeError, setRevokeError] = useState<string | null>(null)
  const [lastRevoked, setLastRevoked] = useState(false)
  const revokingRef = useRef<string | null>(null)

  async function mint(e: React.FormEvent) {
    e.preventDefault()
    if (mintingRef.current) return
    mintingRef.current = true
    setMinting(true)
    setMintError(null)
    setCopied(false)
    try {
      const res = await fetch('/api/kiosk/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: label || undefined, hours: Number(hours) || defaultHours }),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) {
        setMintError(errorMessage(json))
        return
      }
      const doc = json as { url: string; expiresAt: string }
      setMinted({ url: doc.url, expiresAt: doc.expiresAt })
      router.refresh() // pulls the newly minted row into the active-sessions list below
    } catch {
      setMintError(de.kioskAdmin.error)
    } finally {
      mintingRef.current = false
      setMinting(false)
    }
  }

  async function copy() {
    if (!minted) return
    try {
      await navigator.clipboard.writeText(minted.url)
      setCopied(true)
    } catch {
      // Clipboard access can be denied (permissions/insecure context); the URL is still visible
      // and selectable in the read-only input above, so this is a no-op, not a silent failure.
    }
  }

  async function revoke(id: string) {
    if (revokingRef.current) return
    revokingRef.current = id
    setRevokingId(id)
    setRevokeError(null)
    setLastRevoked(false)
    try {
      const res = await fetch('/api/kiosk/session', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sid: Number(id) }),
      })
      if (!res.ok) {
        const json = await res.json().catch(() => null)
        setRevokeError(errorMessage(json))
        return
      }
      setLastRevoked(true)
      router.refresh() // re-fetches the server list, which drops the now-revoked row
    } catch {
      setRevokeError(de.kioskAdmin.error)
    } finally {
      revokingRef.current = null
      setRevokingId(null)
    }
  }

  return (
    <>
      <form onSubmit={mint} style={{ display: 'grid', gap: '0.75rem', maxWidth: 480 }}>
        <label>
          {de.kioskAdmin.label}
          <input value={label} onChange={(e) => setLabel(e.target.value)} disabled={minting} />
        </label>
        <label>
          {de.kioskAdmin.hours}
          <input
            type="number"
            min={1}
            max={defaultHours}
            value={hours}
            onChange={(e) => setHours(e.target.value)}
            disabled={minting}
          />
        </label>
        <button type="submit" disabled={minting}>{de.kioskAdmin.mint}</button>
        {mintError && <p role="alert">{mintError}</p>}
      </form>

      {minted && (
        <div style={{ marginTop: '1rem', display: 'grid', gap: '0.5rem', maxWidth: 480 }}>
          <input readOnly value={minted.url} onFocus={(e) => e.currentTarget.select()} />
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <button type="button" onClick={copy}>{copied ? de.kioskAdmin.copied : de.kioskAdmin.copy}</button>
            <a href={minted.url} target="_blank" rel="noopener noreferrer">{de.kioskAdmin.open}</a>
          </div>
          <div style={{ width: 140, height: 140 }} dangerouslySetInnerHTML={{ __html: qrSvg(minted.url) }} />
        </div>
      )}

      <h2>{de.kioskAdmin.active}</h2>
      {revokeError && <p role="alert">{revokeError}</p>}
      {lastRevoked && !revokeError && <p role="status">{de.kioskAdmin.revoked}</p>}
      {sessions.length === 0 && <p>{de.kioskAdmin.empty}</p>}
      <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: '0.5rem' }}>
        {sessions.map((s) => (
          <li key={s.id} style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <span>{s.label || '—'}</span>
            <span style={{ color: 'var(--muted)', fontSize: '0.85rem' }}>
              {de.kioskAdmin.expiresAt}: {new Date(s.expiresAt).toLocaleString('de-DE')}
            </span>
            <button type="button" onClick={() => revoke(s.id)} disabled={revokingId === s.id}>
              {de.kioskAdmin.revoke}
            </button>
          </li>
        ))}
      </ul>
    </>
  )
}
