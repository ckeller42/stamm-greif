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

// Bounded-concurrency map: runs `fn` over `items` with at most `limit` in flight at once,
// preserving input order in the result array (each worker writes back by its own index, so
// completion order never matters). photoToJpegBuffer() does an fs.readFile + a full sharp
// decode/resize/encode pipeline per photo — letting all of them (up to FOTOBUCH_MAX_PHOTOS = 300)
// run at once would fan out ~300 concurrent pipelines (~150MB+ of transient buffers) on a 2GB
// VPS. A fixed batch of 8 keeps peak memory bounded without adding a dependency (CodeRabbit
// review, PR #23).
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

// RFC 5987 percent-encoding for the Content-Disposition filename*= extended parameter.
// encodeURIComponent() covers most of it but — unlike the RFC's attr-char set — leaves
// ' ( ) * unescaped, so those four are escaped explicitly on top. This is what lets the
// downloaded file keep its real (possibly umlaut-carrying) name in browsers that honour
// filename*=, while the plain filename= alongside it stays the ASCII-sanitized fallback for
// clients that don't (CodeRabbit review, PR #23).
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}

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
  // Number.isInteger rejects NaN/Infinity/fractional up front (mirrors the kiosk session route),
  // and id > 0 rejects 0/negatives — those would otherwise reach a Postgres integer-id findByID
  // and surface as a 500 instead of this clean 400 (consent audit C6).
  if (!type || !['event', 'series', 'person'].includes(type) || !Number.isInteger(id) || id <= 0) {
    return new Response('Bad request', { status: 400 })
  }
  const excludeIds = Array.isArray(body?.excludeIds)
    ? (body!.excludeIds as unknown[]).map(Number).filter((n) => Number.isInteger(n) && n > 0)
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

  const images = await mapWithConcurrency(photos, 8, (p) => photoToJpegBuffer(p as Photo, payload.logger))
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
  // ASCII-only fallback (what every client honours) plus an RFC 5987 filename*=UTF-8'' extended
  // parameter (what modern browsers actually use) so umlauts in the subject's name survive into
  // the downloaded filename instead of being mangled to underscores (CodeRabbit review, PR #23).
  const asciiFilename = (filenameBase.trim().replace(/[^\w.\-]+/g, '_').replace(/^_+|_+$/g, '') || 'fotobuch') + '.pdf'
  const utf8Filename = (filenameBase.trim().replace(/[\r\n\x00-\x1f]+/g, ' ').trim() || 'fotobuch') + '.pdf'
  return new Response(pdf as unknown as BodyInit, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodeRfc5987(utf8Filename)}`,
      'Cache-Control': 'no-store',
    },
  })
}
