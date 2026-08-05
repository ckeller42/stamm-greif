'use client'
import { useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { de } from '@/messages/de'

export default function InvitePage() {
  const { token } = useParams<{ token: string }>()
  const [name, setName] = useState(''); const [email, setEmail] = useState(''); const [password, setPassword] = useState('')
  const [invalid, setInvalid] = useState(false)
  const [error, setError] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  // Synchronous guard against a double-click/double-Enter that both fire before the button
  // disables — otherwise the account-creating POST would run twice (the second failing on the
  // now-duplicate email).
  const submittingRef = useRef(false)
  const router = useRouter()
  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true)
    setError(false)
    try {
      const res = await fetch('/api/invites/accept', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, name, email, password }),
      })
      if (res.ok) {
        await fetch('/api/users/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        })
        router.push('/'); router.refresh()
      } else if (res.status === 404 || res.status === 410) {
        // Only an unknown or already-used/expired invite means the invite
        // itself is invalid. Any other failure (400 missing fields, 500 e.g.
        // duplicate email) is a correctable input error — keep the form.
        setInvalid(true)
      } else {
        setError(true)
      }
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }
  return (
    <form onSubmit={submit} className="card" style={{ maxWidth: 360, margin: '4rem auto', padding: '2rem', display: 'grid', gap: '0.75rem' }}>
      <h1>{de.invite.title}</h1>
      {invalid ? (
        <p role="alert">{de.invite.invalid}</p>
      ) : (
        <>
          <label>{de.invite.name}<input type="text" value={name} onChange={(e) => setName(e.target.value)} required /></label>
          <label>{de.login.email}<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
          <label>{de.login.password}<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
          <button type="submit" disabled={submitting}>{de.invite.submit}</button>
          {error && <p role="alert">{de.invite.error}</p>}
        </>
      )}
    </form>
  )
}
