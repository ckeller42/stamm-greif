'use client'
import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { de } from '@/messages/de'

export default function LoginPage() {
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('')
  const [error, setError] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  // A ref is read/written synchronously, so it blocks a genuine double-click or double-Enter
  // that both fire before React re-renders the disabled button — sending the login twice would
  // otherwise burn two of Payload's login attempts and trip the account lock early.
  const submittingRef = useRef(false)
  const router = useRouter()
  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true)
    setError(false)
    try {
      const res = await fetch('/api/users/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      if (res.ok) { router.push('/'); router.refresh() } else setError(true)
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }
  return (
    <form onSubmit={submit} className="card" style={{ maxWidth: 360, margin: '4rem auto', padding: '2rem', display: 'grid', gap: '0.75rem' }}>
      <h1>{de.login.title}</h1>
      <label>{de.login.email}<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
      <label>{de.login.password}<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
      <button type="submit" disabled={submitting}>{de.login.submit}</button>
      {error && <p role="alert">{de.login.error}</p>}
    </form>
  )
}
