'use client'
import { useRef, useState } from 'react'
import { de } from '@/messages/de'
import type { FotobuchTargetType } from '@/lib/fotobuch-query'

type PhotoRow = { id: number; caption: string | null; thumbUrl: string | null }

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
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'fotobuch.pdf' // the server's Content-Disposition filename wins where honoured
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

  if (photos.length === 0) return <p>{de.fotobuch.empty}</p>

  return (
    <div>
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
      <button type="button" onClick={generate} disabled={busy}>
        {busy ? de.fotobuch.generating : de.fotobuch.generate}
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  )
}
