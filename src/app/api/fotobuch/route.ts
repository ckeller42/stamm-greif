import { getPayload } from 'payload'
import config from '@payload-config'
import { getUser } from '@/lib/get-user'
import {
  collectFotobuchPhotos,
  FOTOBUCH_MAX_PHOTOS,
  FotobuchHiddenPersonError,
  type FotobuchTargetType,
} from '@/lib/fotobuch-query'
import { photoToJpegBuffer } from '@/lib/fotobuch-image'
import { renderFotobuchPdf, type FotobuchBook, type FotobuchImage, type FotobuchHistory } from '@/lib/fotobuch-document'
import { fotobuchDateRange } from '@/lib/fotobuch-title'
import { lexicalToPlainText } from '@/lib/lexical-text'
import { parseFuzzyDate, type FuzzyPrecision } from '@/lib/fuzzy-date'
import { formatRange } from '@/lib/time-range'
import { de } from '@/messages/de'
import type { Photo } from '@/payload-types'

export const dynamic = 'force-dynamic'

// POST /api/fotobuch  { type: 'event'|'series'|'person', id, excludeIds? } → application/pdf.
// A Next route handler (the /api/health, /api/kiosk/* class — wins over Payload's /api/[...slug]
// catchall; there is no `fotobuch` collection). Kurator/admin only. The consent filter is
// re-applied server-side regardless of excludeIds (spec §3, §7): excludeIds can only REMOVE.
export async function POST(req: Request): Promise<Response> {
  const user = await getUser()
  if (!user) return new Response('Unauthorized', { status: 401 })
  if (user.role !== 'admin' && user.role !== 'kurator') return new Response('Forbidden', { status: 403 })

  const body = (await req.json().catch(() => null)) as
    | { type?: string; id?: number | string; excludeIds?: unknown }
    | null
  const type = body?.type as FotobuchTargetType | undefined
  const id = Number(body?.id)
  if (!type || !['event', 'series', 'person'].includes(type) || !Number.isFinite(id)) {
    return new Response('Bad request', { status: 400 })
  }
  const excludeIds = Array.isArray(body?.excludeIds)
    ? (body!.excludeIds as unknown[]).map(Number).filter(Number.isFinite)
    : []

  const payload = await getPayload({ config })

  // Subject meta + (person) refusal + history. Everything loaded overrideAccess:true, but note
  // that reading the SUBJECT is not the consent-sensitive part — the PHOTOS are, and those go
  // exclusively through collectFotobuchPhotos below.
  let title = ''
  let subtitle = ''
  let storyHeading = ''
  let story = ''
  let history: FotobuchHistory | null = null
  let filenameBase = 'fotobuch'

  if (type === 'person') {
    const person = await payload.findByID({ collection: 'people', id, overrideAccess: true, disableErrors: true, depth: 0 })
    if (!person) return new Response('Not found', { status: 404 })
    // Safety-critical: a person who has withdrawn consent gets NO book (spec §2, §3).
    if (person.hidden) return new Response(de.fotobuch.refusedHidden, { status: 403 })
    title = person.name
    subtitle = fotobuchDateRange({ type: 'person', name: person.name, birthYear: person.birthYear })
    storyHeading = de.fotobuch.storyPerson
    story = typeof person.bio === 'string' ? person.bio : ''
    filenameBase = person.name

    const [memberships, attendance] = await Promise.all([
      payload.find({ collection: 'memberships', where: { person: { equals: id } }, sort: 'vonYear', pagination: false, depth: 1, overrideAccess: true }),
      payload.find({ collection: 'attendance', where: { person: { equals: id } }, pagination: false, depth: 1, overrideAccess: true }),
    ])
    history = {
      gruppenHeading: de.fotobuch.gruppen,
      memberships: memberships.docs.map((m) => {
        const group = typeof m.group === 'object' && m.group ? m.group.name : ''
        const role = de.person.rollen[m.role as keyof typeof de.person.rollen] ?? m.role
        const range = formatRange({ von: m.vonYear, bis: m.bisYear })
        return [group, role, range].filter(Boolean).join(' · ')
      }),
      ereignisseHeading: de.fotobuch.ereignisse,
      events: attendance.docs
        .map((a) => (typeof a.event === 'object' && a.event ? a.event.name : null))
        .filter((n): n is string => Boolean(n)),
    }
  } else if (type === 'event') {
    const event = await payload.findByID({ collection: 'events', id, overrideAccess: true, disableErrors: true, depth: 0 })
    if (!event) return new Response('Not found', { status: 404 })
    title = event.name
    subtitle = fotobuchDateRange({ type: 'event', name: event.name, datePrecision: event.datePrecision, dateValue: event.dateValue })
    storyHeading = de.fotobuch.storyEvent
    story = lexicalToPlainText(event.story)
    filenameBase = event.name
  } else {
    const series = await payload.findByID({ collection: 'event-series', id, overrideAccess: true, disableErrors: true, depth: 0 })
    if (!series) return new Response('Not found', { status: 404 })
    const events = await payload.find({ collection: 'events', where: { series: { equals: id } }, pagination: false, depth: 0, overrideAccess: true })
    const years = events.docs
      .map((e) => parseFuzzyDate({ precision: (e.datePrecision ?? 'unknown') as FuzzyPrecision, value: e.dateValue }).sortKey)
      .filter((k): k is number => k != null)
      .map((k) => Math.floor(k / 10_000))
    title = series.name
    subtitle = fotobuchDateRange({ type: 'series', name: series.name, years })
    storyHeading = de.fotobuch.storySeries
    story = typeof series.description === 'string' ? series.description : ''
    filenameBase = series.name
  }

  // THE consent set (spec §3). overrideAccess:true made safe only by fotobuchPhotoWhere().
  // Wrapped in try/catch (belt-and-braces beyond the upfront `person.hidden` check above): the
  // two checks aren't atomic, so a person could in principle be hidden between them — this catch
  // turns that narrow race into the same clean 403 rather than an uncaught 500.
  let photos
  try {
    photos = await collectFotobuchPhotos(payload, { type, id, excludeIds })
  } catch (err) {
    if (err instanceof FotobuchHiddenPersonError) {
      return new Response(de.fotobuch.refusedHidden, { status: 403 })
    }
    throw err
  }

  const images = await Promise.all(photos.map((p) => photoToJpegBuffer(p as Photo, payload.logger)))
  const toImage = (buf: Buffer | null): FotobuchImage => (buf ? { data: buf, format: 'jpg' } : null)

  const book: FotobuchBook = {
    title,
    subtitle,
    cover: toImage(images[0] ?? null),
    storyHeading,
    story,
    history,
    photos: photos.map((p, i) => ({
      image: toImage(images[i]),
      caption: p.caption ?? null,
      dateLabel: parseFuzzyDate({ precision: (p.datePrecision ?? 'unknown') as FuzzyPrecision, value: p.dateValue }).label,
    })),
    photosHeading: de.fotobuch.fotos,
    emptyPhotosLabel: de.fotobuch.emptyPhotos,
    truncatedNote: photos.length >= FOTOBUCH_MAX_PHOTOS ? de.fotobuch.truncated : null,
    footer: de.fotobuch.footer,
  }

  const pdf = await renderFotobuchPdf(book)
  const filename = (filenameBase.trim().replace(/[^\w.\-]+/g, '_').replace(/^_+|_+$/g, '') || 'fotobuch') + '.pdf'
  return new Response(pdf as unknown as BodyInit, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  })
}
