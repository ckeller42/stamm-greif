'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { de } from '@/messages/de'

type Props = {
  suggestionId: string
  defaultPersonId: string
  people: { id: string; name: string }[]
}

export function FaceReviewForm({ suggestionId, defaultPersonId, people }: Props) {
  const router = useRouter()
  const [personId, setPersonId] = useState(defaultPersonId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function act(action: 'bestaetigen' | 'ablehnen') {
    if (busy) return // re-entrancy guard, same as UploadForm's
    if (action === 'bestaetigen' && !personId) {
      setError(de.gesichter.needsPerson)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/face-suggestions/${suggestionId}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action === 'bestaetigen' ? { personId } : {}),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        setError(body?.error ?? de.gesichter.error)
        return
      }
      router.refresh()
    } catch {
      setError(de.gesichter.error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.5rem', flexWrap: 'wrap' }}>
      <label>
        {de.gesichter.person}{' '}
        <select value={personId} onChange={(e) => setPersonId(e.target.value)} disabled={busy}>
          <option value="">{de.gesichter.choose}</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </label>
      <button type="button" onClick={() => act('bestaetigen')} disabled={busy}>
        {busy ? de.gesichter.saving : de.gesichter.confirm}
      </button>
      <button type="button" onClick={() => act('ablehnen')} disabled={busy}>
        {de.gesichter.reject}
      </button>
      {error && <span role="alert">{error}</span>}
    </div>
  )
}
