'use client'
import { useRef, useState } from 'react'
import { de } from '@/messages/de'
import type { FotobuchTargetType } from '@/lib/fotobuch-query'

type PhotoRow = { id: number; caption: string | null; thumbUrl: string | null }

// Reads the real filename the server chose (route.ts sends both an ASCII filename= fallback and
// an RFC 5987 filename*=UTF-8'' extended parameter so umlauts survive) instead of always saving
// as the generic "fotobuch.pdf" (CodeRabbit review, PR #23). Prefers the extended form; falls
// back to the plain one, then to a hardcoded default if the header is missing/unparsable.
function filenameFromContentDisposition(header: string | null): string {
  if (!header) return 'fotobuch.pdf'
  const extended = /filename\*=UTF-8''([^;]+)/i.exec(header)
  if (extended) {
    try {
      const decoded = decodeURIComponent(extended[1].trim())
      if (decoded) return decoded
    } catch {
      // malformed percent-encoding — fall through to the plain filename below
    }
  }
  const plain = /filename="([^"]*)"/i.exec(header) ?? /filename=([^;]+)/i.exec(header)
  const name = plain?.[1]?.trim()
  return name || 'fotobuch.pdf'
}

export function FotobuchForm({ type, id, photos }: { type: FotobuchTargetType; id: number; photos: PhotoRow[] }) {
  const [excluded, setExcluded] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Same reentrancy trick as UploadForm.uploadingRef / KioskAdmin.mintingRef: setBusy() is
  // batched/asynchronous, so two clicks landing in the same task before React re-renders the
  // (disabled) button would both read a stale `busy === false` closure. A ref is read/written
  // synchronously, so the very first line of generate() sees the true current state.
  const busyRef = useRef(false)

  function toggle(pid: number) {
    setExcluded((prev) => {
      const next = new Set(prev)
      next.has(pid) ? next.delete(pid) : next.add(pid)
      return next
    })
  }

  async function generate() {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/fotobuch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, id, excludeIds: Array.from(excluded) }),
      })
      if (!res.ok) throw new Error(String(res.status))
      const filename = filenameFromContentDisposition(res.headers.get('Content-Disposition'))
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch {
      setError(de.fotobuch.error)
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  // A zero-photo book is a legal endpoint output (renderFotobuchPdf shows de.fotobuch.emptyPhotos
  // as a page of its own rather than failing), so this must NOT early-return out of the form —
  // that would remove the only way to reach "PDF erzeugen" and leave a kurator stuck (CodeRabbit
  // review, PR #23). Show the empty-state message in place of the (pointless, nothing-to-exclude)
  // checkbox grid, but keep the button.
  return (
    <div>
      {photos.length === 0 ? (
        <p>{de.fotobuch.emptyPhotos}</p>
      ) : (
        <ul style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', listStyle: 'none', padding: 0 }}>
          {photos.map((p) => (
            <li key={p.id} style={{ width: 140 }}>
              {p.thumbUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={p.thumbUrl}
                  alt={p.caption ?? ''}
                  style={{ width: '100%', opacity: excluded.has(p.id) ? 0.35 : 1 }}
                />
              )}
              <label style={{ fontSize: '0.8rem', display: 'block' }}>
                <input type="checkbox" checked={excluded.has(p.id)} onChange={() => toggle(p.id)} disabled={busy} />{' '}
                {de.fotobuch.exclude}
              </label>
            </li>
          ))}
        </ul>
      )}
      <button type="button" onClick={generate} disabled={busy}>
        {busy ? de.fotobuch.generating : de.fotobuch.generate}
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  )
}
