'use client'
import { useRef, useState } from 'react'
import { de } from '@/messages/de'
import { formatServerError } from '@/lib/server-error'

type FileState = { file: File; status: 'wartet' | 'lädt' | 'fertig' | 'fehler'; serverError?: string }

const statusLabels: Record<FileState['status'], string> = {
  wartet: de.upload.status.wartet,
  lädt: de.upload.status.laedt,
  fertig: de.upload.status.fertig,
  fehler: de.upload.status.fehler,
}

export function UploadForm() {
  const [files, setFiles] = useState<FileState[]>([])
  const [caption, setCaption] = useState('')
  const [year, setYear] = useState('')
  const [done, setDone] = useState(false)
  const [uploading, setUploading] = useState(false)
  // React state updates from setUploading() are batched/asynchronous, so two clicks
  // dispatched within the same task (e.g. a genuine double-click, or two synthetic
  // clicks before React re-renders and disables the button) would both read a stale
  // `uploading === false` closure and both start an upload loop. A ref is read/written
  // synchronously, so the very first line of submit() sees the true current state
  // regardless of render timing — a real reentrancy guard, not just a UI disable.
  const uploadingRef = useRef(false)

  async function uploadOne(fs: FileState): Promise<{ status: 'fertig' | 'fehler'; serverError?: string }> {
    const body = new FormData()
    body.append('file', fs.file)
    body.append('_payload', JSON.stringify({
      caption: caption || undefined,
      datePrecision: year ? 'year' : 'unknown',
      dateValue: year || undefined,
      _status: 'draft',
    }))
    try {
      const res = await fetch('/api/photos', { method: 'POST', body })
      if (res.ok) return { status: 'fertig' }
      const msg = formatServerError(await res.json().catch(() => null))
      return { status: 'fehler', serverError: msg ?? undefined }
    } catch { return { status: 'fehler' } }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (uploadingRef.current) return
    uploadingRef.current = true
    setUploading(true)
    try {
      for (const fs of files) {
        if (fs.status === 'fertig') continue
        setFiles((cur) => cur.map((f) => (f === fs ? { ...f, status: 'lädt', serverError: undefined } : f)))
        const { status, serverError } = await uploadOne(fs)
        setFiles((cur) => cur.map((f) => (f.file === fs.file ? { ...f, status, serverError } : f)))
      }
      setDone(true)
    } finally {
      uploadingRef.current = false
      setUploading(false)
    }
  }

  const hasErrors = files.some((f) => f.status === 'fehler')
  return (
    <form onSubmit={submit} style={{ display: 'grid', gap: '0.75rem', maxWidth: 480 }}>
      <input type="file" accept="image/*" multiple required disabled={uploading}
        onChange={(e) => {
          if (uploadingRef.current) return
          setDone(false)
          setFiles(Array.from(e.target.files ?? []).map((file) => ({ file, status: 'wartet' })))
        }} />
      <label>{de.upload.caption}<input value={caption} onChange={(e) => setCaption(e.target.value)} /></label>
      <label>{de.upload.year}<input type="number" min="1900" max="2100" value={year} onChange={(e) => setYear(e.target.value)} /></label>
      <button type="submit" disabled={uploading}>{de.upload.submit}</button>
      <ul>
        {files.map((f, i) => <li key={i}>{f.file.name} — {statusLabels[f.status]}{f.serverError ? ` — ${f.serverError}` : ''}</li>)}
      </ul>
      {done && !hasErrors && files.length > 0 && <p>{de.upload.success}</p>}
      {done && hasErrors && <p role="alert">{de.upload.error}</p>}
    </form>
  )
}
