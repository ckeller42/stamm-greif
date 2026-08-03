'use client'
import { useState } from 'react'
import { de } from '@/messages/de'

type FileState = { file: File; status: 'wartet' | 'lädt' | 'fertig' | 'fehler' }

export function UploadForm() {
  const [files, setFiles] = useState<FileState[]>([])
  const [caption, setCaption] = useState('')
  const [year, setYear] = useState('')
  const [done, setDone] = useState(false)

  async function uploadOne(fs: FileState): Promise<'fertig' | 'fehler'> {
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
      return res.ok ? 'fertig' : 'fehler'
    } catch { return 'fehler' }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    for (const fs of files) {
      if (fs.status === 'fertig') continue
      setFiles((cur) => cur.map((f) => (f === fs ? { ...f, status: 'lädt' } : f)))
      const status = await uploadOne(fs)
      setFiles((cur) => cur.map((f) => (f.file === fs.file ? { ...f, status } : f)))
    }
    setDone(true)
  }

  const hasErrors = files.some((f) => f.status === 'fehler')
  return (
    <form onSubmit={submit} style={{ display: 'grid', gap: '0.75rem', maxWidth: 480 }}>
      <input type="file" accept="image/*" multiple required
        onChange={(e) => { setDone(false); setFiles(Array.from(e.target.files ?? []).map((file) => ({ file, status: 'wartet' }))) }} />
      <label>{de.upload.caption}<input value={caption} onChange={(e) => setCaption(e.target.value)} /></label>
      <label>{de.upload.year}<input type="number" min="1900" max="2100" value={year} onChange={(e) => setYear(e.target.value)} /></label>
      <button type="submit">{de.upload.submit}</button>
      <ul>
        {files.map((f, i) => <li key={i}>{f.file.name} — {f.status}</li>)}
      </ul>
      {done && !hasErrors && files.length > 0 && <p>{de.upload.success}</p>}
      {done && hasErrors && <p role="alert">{de.upload.error}</p>}
    </form>
  )
}
