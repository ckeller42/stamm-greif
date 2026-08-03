'use client'
import { useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { de } from '@/messages/de'

export default function InvitePage() {
  const { token } = useParams<{ token: string }>()
  const [name, setName] = useState(''); const [email, setEmail] = useState(''); const [password, setPassword] = useState('')
  const [invalid, setInvalid] = useState(false)
  const router = useRouter()
  async function submit(e: React.FormEvent) {
    e.preventDefault()
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
    } else {
      setInvalid(true)
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
          <button type="submit">{de.invite.submit}</button>
        </>
      )}
    </form>
  )
}
