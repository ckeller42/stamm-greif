'use client'
import { useRef, useState } from 'react'
import { de } from '@/messages/de'
import { formatServerError } from '@/lib/server-error'

type FileState = {
  file: File
  status: 'wartet' | 'lädt' | 'fertig' | 'fehler'
  serverError?: string
  duplicateSuspected?: boolean
}

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

  async function uploadOne(
    fs: FileState,
  ): Promise<{ status: 'fertig' | 'fehler'; serverError?: string; duplicateSuspected?: boolean }> {
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
      const json = await res.json().catch(() => null)
      if (res.ok) {
        // duplicateSuspected (unlike duplicateOf, which is kurator/admin-only) is readable by
        // the uploading mitglied themselves — see Photos.ts's field comment — so the create
        // response already carries it whenever the just-uploaded file's perceptual hash landed
        // close enough to an existing photo.
        const doc = (json as { doc?: { duplicateSuspected?: boolean } } | null)?.doc
        return { status: 'fertig', duplicateSuspected: Boolean(doc?.duplicateSuspected) }
      }
      const msg = formatServerError(json)
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
        // m6 (review): a retry (re-submit after a partial failure) must clear BOTH the previous
        // attempt's serverError and duplicateSuspected — otherwise a file that was flagged as a
        // possible duplicate on a prior attempt would still show the warning while "lädt" is
        // showing for the new attempt, even if the retry's own response comes back clean.
        // Match predicate aligned with the one two lines below (`f.file === fs.file`, not
        // `f === fs`) for consistency — both happen to match the same element under this
        // component's current control flow (nothing else can reorder/replace `files` mid-loop:
        // the file input and submit button are both disabled while `uploading` is true), but
        // matching by the `File` object rather than by FileState identity is the more robust
        // invariant to hold if that ever changes, and having both status-transition call sites
        // use the same predicate is easier to reason about than two different ones that happen to
        // agree today.
        setFiles((cur) =>
          cur.map((f) => (f.file === fs.file ? { ...f, status: 'lädt', serverError: undefined, duplicateSuspected: undefined } : f)),
        )
        const { status, serverError, duplicateSuspected } = await uploadOne(fs)
        setFiles((cur) => cur.map((f) => (f.file === fs.file ? { ...f, status, serverError, duplicateSuspected } : f)))
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
      <input type="file" accept="image/jpeg,image/png,image/tiff,image/webp,image/heic,image/heif" multiple required disabled={uploading}
        onChange={(e) => {
          if (uploadingRef.current) return
          setDone(false)
          setFiles(Array.from(e.target.files ?? []).map((file) => ({ file, status: 'wartet' })))
        }} />
      <p style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>{de.upload.formats}</p>
      <label>{de.upload.caption}<input value={caption} onChange={(e) => setCaption(e.target.value)} /></label>
      <label>{de.upload.year}<input type="number" min="1900" max="2100" value={year} onChange={(e) => setYear(e.target.value)} /></label>
      <button type="submit" disabled={uploading}>{de.upload.submit}</button>
      <ul>
        {files.map((f, i) => (
          <li key={i}>
            {f.file.name} — {statusLabels[f.status]}
            {f.serverError ? ` — ${f.serverError}` : ''}
            {f.duplicateSuspected ? ` — ${de.upload.duplicateWarning}` : ''}
          </li>
        ))}
      </ul>
      {done && !hasErrors && files.length > 0 && <p>{de.upload.success}</p>}
      {done && hasErrors && <p role="alert">{de.upload.error}</p>}
    </form>
  )
}
