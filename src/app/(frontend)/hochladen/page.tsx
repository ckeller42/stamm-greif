import { redirect } from 'next/navigation'
import { getUser } from '@/lib/get-user'
import { de } from '@/messages/de'
import { UploadForm } from './UploadForm'

export default async function UploadPage() {
  const user = await getUser()
  if (!user) redirect('/anmelden')
  return (
    <>
      <h1>{de.upload.title}</h1>
      <p style={{ color: 'var(--muted)' }}>{de.upload.hint}</p>
      <UploadForm />
    </>
  )
}
