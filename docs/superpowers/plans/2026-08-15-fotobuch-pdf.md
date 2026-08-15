# Fotobuch PDF-Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A kurator/admin picks an Event, EventSeries, or Person and downloads a print-ready A4 **PDF** (cover, story/bio, chronological captioned photo grid; person books add the Sippen/Meuten + events history). Rendered in-process with `@react-pdf/renderer` — no headless browser, no new container. The output carries the **hardest consent bar in the project**: only published, not-hidden-person, not-binned photos, enforced server-side regardless of the generating kurator's role; a hidden person gets no book.

**Architecture:** `POST /api/fotobuch` (Next route handler, kurator/admin-gated) → `collectFotobuchPhotos()` builds the consent-filtered photo set with `overrideAccess: true` + `fotobuchPhotoWhere()` (the `kioskPhotoWhere()` sibling, AND-terms minus the kiosk allowlist), subtracts request `excludeIds` **in code** → each photo's `web` derivative is read from `<cwd>/photos` and transcoded to a bounded JPEG buffer via `sharp` → `renderFotobuchPdf()` builds the react-pdf document from buffers → streamed back as `application/pdf` attachment. Sync, bounded by `FOTOBUCH_MAX_PHOTOS = 300`. No schema, no migration, no new env.

**Tech Stack:** `@react-pdf/renderer@4.6.1` (pure JS + yoga WASM, no native/glibc dep — verified in the spec §5), the repo's existing `sharp`, Payload 3.87 Local API, Next.js 16 route handlers.

**Spec:** `docs/superpowers/specs/2026-08-15-fotobuch-pdf-design.md`

## Global Constraints

- Branch `p2-fotobuch` (this plan + spec are committed on `p2-fotobuch-spec`; the implementation PR branches as `p2-fotobuch`). Every commit ends with the two trailer lines shown by `git log -1 --format=%B` (Co-Authored-By + Claude-Session).
- **The consent filter lives in exactly one place** — `fotobuchPhotoWhere()` in `src/lib/fotobuch-query.ts`. Both the endpoint and the exclude page reach the photo set only through `collectFotobuchPhotos()`. Never inline the `where`.
- **`excludeIds` can only REMOVE.** It is subtracted from the already-consent-filtered set in code, never unioned into the query. A hidden-person photo can never be forced in.
- **Consent uses `overrideAccess: true` + the hand-written filter, NOT `overrideAccess: false` + the kurator `user`** — a kurator's `canReadPhoto` returns `true` and would leak hidden/draft/binned photos into the durable file.
- **A person book of a `hidden` person is refused (HTTP 403).**
- German UI strings live in `src/messages/de.ts` — never hardcode German in components.
- No new collection, no new field, **no migration**: CI's drift check (`migrate:create ci_drift_check --skip-empty`) must stay clean (produce nothing). No `.env` change.
- All existing tests stay green. `pnpm exec tsc --noEmit` and `pnpm lint` clean after every task.
- `FOTOBUCH_MAX_PHOTOS = 300` is a module constant, not an env var.
- Book photos are ordered oldest→newest (`sort: 'dateSortKey'` ascending); the cover image is the first (oldest) photo.

---

### Task 1: Add `@react-pdf/renderer`, verify it's pure-JS/WASM on this toolchain, wire the build

**Files:**
- Modify: `package.json` (dependency)
- Modify: `next.config.ts` (`serverExternalPackages`)
- Create: `scripts/probe-fotobuch.mjs` (render probe, mirrors `scripts/probe-faces.mjs`)

**Interfaces:** none exported yet — this task proves the engine installs and renders in this repo's toolchain and the standalone build.

- [ ] **Step 1: Install** — `pnpm add @react-pdf/renderer` (expect `4.6.x`). Then confirm the tree carries **no native addon**:

```bash
# Must print nothing — no compiled binary, no node-gyp install step, no second sharp:
find node_modules/@react-pdf node_modules/yoga-layout node_modules/fontkit -name '*.node' 2>/dev/null
node -e "const t=require('node:child_process').execSync('pnpm why sharp',{encoding:'utf8'}); console.log(/@react-pdf/.test(t)?'FAIL: react-pdf pulled sharp':'ok: no react-pdf->sharp')"
```

Expected: the `find` prints nothing (yoga is WASM, not a `.node` addon), and the second line prints `ok`. If either fails, stop — the spec's engine assumption (§5) is wrong and the design needs revisiting.

- [ ] **Step 2: Render probe** — create `scripts/probe-fotobuch.mjs`:

```javascript
// Build-time / local probe that @react-pdf/renderer actually renders a PDF in this toolchain —
// the same silent-fallback guard rationale as scripts/probe-faces.mjs (a green build that only
// throws at first render, e.g. because next's standalone trace dropped yoga's wasm asset).
import React from 'react'
import { Document, Page, Text, renderToBuffer } from '@react-pdf/renderer'

const doc = React.createElement(
  Document,
  null,
  React.createElement(Page, { size: 'A4' }, React.createElement(Text, null, 'Grüße vom Stamm Greif — ä ö ü ß 1985–2025')),
)
const buf = await renderToBuffer(doc)
if (!buf || buf.length === 0 || buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
  console.error('fotobuch probe FAILED: no valid PDF produced')
  process.exit(1)
}
console.log(`fotobuch probe ok: ${buf.length} bytes, umlauts render on built-in Helvetica`)
```

Run it: `node scripts/probe-fotobuch.mjs` — must print `fotobuch probe ok: … bytes`. This also confirms the built-in Helvetica renders German umlauts + en-dash (spec §5), so no embedded font is needed.

- [ ] **Step 3: `next.config.ts`** — add `@react-pdf/renderer` to `serverExternalPackages` so Next leaves it a runtime require (exactly the treatment `onnxruntime-web` already gets). If — and only if — the Task 6/7 docker build's render check (below) shows yoga's wasm/asm asset missing from the standalone bundle, additionally add an `outputFileTracingIncludes` entry for it, mirroring the existing `onnxruntime-web` wasm include. Do not add the tracing include speculatively; the probe in the docker job is what tells you whether it's needed.

- [ ] **Step 4: Verify** — `pnpm exec tsc --noEmit` clean; `pnpm lint` clean; `node scripts/probe-fotobuch.mjs` prints ok. Record the `node_modules` size delta (`du -sh node_modules/@react-pdf node_modules/yoga-layout node_modules/fontkit`) for the betrieb.md rollout note (expected +5–10 MB total).

- [ ] **Step 5: Commit** — `feat: add @react-pdf/renderer (pure JS/WASM PDF engine) + render probe`

---

### Task 2: The consent filter + photo-set builder (the load-bearing safety artifact)

**Files:**
- Create: `src/lib/fotobuch-query.ts`
- Test: `tests/unit/fotobuch-query.test.ts`

**Interfaces:**
- Produces: `fotobuchPhotoWhere(): Where`, `FOTOBUCH_MAX_PHOTOS: number`, `type FotobuchTargetType = 'event'|'series'|'person'`, `collectFotobuchPhotos(payload, { type, id, excludeIds? }): Promise<Photo[]>`. Task 5 (endpoint) and the int/unit tests import exactly these.

- [ ] **Step 1: Write the failing unit test** — `tests/unit/fotobuch-query.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { fotobuchPhotoWhere, FOTOBUCH_MAX_PHOTOS } from '@/lib/fotobuch-query'
import { kioskPhotoWhere } from '@/lib/kiosk-query'

describe('fotobuchPhotoWhere', () => {
  it('ANDs exactly published + not-hidden-person + not-binned', () => {
    expect(fotobuchPhotoWhere()).toEqual({
      and: [
        { _status: { equals: 'published' } },
        { hasHiddenPerson: { not_equals: true } },
        { deletedAt: { exists: false } },
      ],
    })
  })

  it('is the kiosk filter MINUS the kiosk allowlist (no kioskFreigegeben, no OR)', () => {
    const json = JSON.stringify(fotobuchPhotoWhere())
    expect(json).not.toContain('kioskFreigegeben')
    expect(json).not.toContain('"or"')
    // every fotobuch term is present in the kiosk filter (fotobuch ⊂ kiosk terms)
    const kioskTerms = JSON.stringify((kioskPhotoWhere() as { and: unknown[] }).and)
    for (const term of (fotobuchPhotoWhere() as { and: unknown[] }).and) {
      expect(kioskTerms).toContain(JSON.stringify(term))
    }
  })
})

describe('FOTOBUCH_MAX_PHOTOS', () => {
  it('is a sane positive cap', () => {
    expect(FOTOBUCH_MAX_PHOTOS).toBe(300)
  })
})
```

- [ ] **Step 2: Run it — must fail** (`pnpm exec vitest run tests/unit/fotobuch-query.test.ts`; expected: cannot resolve `@/lib/fotobuch-query`).

- [ ] **Step 3: Implement `src/lib/fotobuch-query.ts`**:

```typescript
import type { Payload, Where } from 'payload'
import type { Photo } from '@/payload-types'

// A single event/series/person book is bounded to dozens–low-hundreds of photos; this cap bounds
// worst-case render work and memory so generation stays a safe synchronous request (spec §6.5).
// A module constant, not an env var, deliberately — keeps .env stable (a stated non-goal).
export const FOTOBUCH_MAX_PHOTOS = 300

export type FotobuchTargetType = 'event' | 'series' | 'person'

// THE consent filter for the durable PDF export (spec §3). Direct sibling of kioskPhotoWhere():
// the SAME AND-terms MINUS the kiosk allowlist. The PDF leaves the system, so it gets the same
// consent bar as any shared surface — and, unlike the app's own views, it holds even for a
// kurator (whose canReadPhoto returns true and would otherwise leak hidden-person photos into the
// file). Imported ONLY through collectFotobuchPhotos below; never inline this `where`.
//
//   _status == 'published'     never a draft
//   hasHiddenPerson != true    never a hidden-person photo — nothing can override this
//   deletedAt not exists       never a binned photo
export function fotobuchPhotoWhere(): Where {
  return {
    and: [
      { _status: { equals: 'published' } },
      { hasHiddenPerson: { not_equals: true } },
      { deletedAt: { exists: false } },
    ],
  }
}

/**
 * The consent-filtered, ordered, capped photo set a book is built from (spec §3, §6.1).
 *
 * - `overrideAccess: true` is REQUIRED and safe ONLY because fotobuchPhotoWhere() reconstructs the
 *   full consent filter — the same posture the kiosk uses, for the same reason (a kurator's
 *   canReadPhoto short-circuits to `true` and must not decide what enters a durable file).
 * - `excludeIds` is subtracted in code AFTER the query — it can only REMOVE. It is never merged
 *   into the `where`, so it can never re-admit a hidden-person / draft / binned photo.
 * - Ordered oldest→newest so the book reads chronologically; the cover is the first (oldest) photo.
 */
export async function collectFotobuchPhotos(
  payload: Payload,
  args: { type: FotobuchTargetType; id: number; excludeIds?: number[] },
): Promise<Photo[]> {
  const { type, id, excludeIds = [] } = args

  let subject: Where
  if (type === 'event') {
    subject = { event: { equals: id } }
  } else if (type === 'person') {
    subject = { people: { contains: id } }
  } else {
    // Series: photos are linked to a single `event`, not to a series directly — so resolve the
    // series' events first, then photos whose event is one of them. Two explicit steps rather than
    // a nested relationship query, so the shape is obvious and deterministic.
    const events = await payload.find({
      collection: 'events',
      where: { series: { equals: id } },
      select: {},
      pagination: false,
      depth: 0,
      overrideAccess: true,
    })
    const eventIds = events.docs.map((e) => e.id)
    if (eventIds.length === 0) return []
    subject = { event: { in: eventIds } }
  }

  const res = await payload.find({
    collection: 'photos',
    where: { and: [subject, fotobuchPhotoWhere()] },
    sort: 'dateSortKey', // ascending — oldest first
    limit: FOTOBUCH_MAX_PHOTOS,
    depth: 0,
    overrideAccess: true,
  })

  const exclude = new Set(excludeIds.map(String))
  return res.docs.filter((p) => !exclude.has(String(p.id))) as Photo[]
}
```

- [ ] **Step 4: Run the unit test — must pass.**
- [ ] **Step 5: Verify** — `pnpm exec tsc --noEmit` + `pnpm lint` clean. **Commit** — `feat: fotobuch consent filter + photo-set builder (fotobuchPhotoWhere, collectFotobuchPhotos)`

---

### Task 3: Pure helpers — Lexical→text + title/date-range formatting

**Files:**
- Create: `src/lib/lexical-text.ts`
- Create: `src/lib/fotobuch-title.ts`
- Test: `tests/unit/lexical-text.test.ts`, `tests/unit/fotobuch-title.test.ts`

**Interfaces:**
- Produces: `lexicalToPlainText(state: unknown): string`; `type FotobuchSubject`, `fotobuchTitle(s): string`, `fotobuchDateRange(s): string`. Tasks 4/5 import these.

- [ ] **Step 1: Failing unit tests.**

`tests/unit/lexical-text.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { lexicalToPlainText } from '@/lib/lexical-text'

const state = (children: unknown[]) => ({ root: { type: 'root', children } })
const para = (text: string) => ({ type: 'paragraph', children: [{ type: 'text', text }] })

describe('lexicalToPlainText', () => {
  it('joins paragraphs with blank lines', () => {
    expect(lexicalToPlainText(state([para('Erster Absatz.'), para('Zweiter Absatz.')]))).toBe(
      'Erster Absatz.\n\nZweiter Absatz.',
    )
  })

  it('keeps link text, drops the url', () => {
    const withLink = state([
      { type: 'paragraph', children: [
        { type: 'text', text: 'siehe ' },
        { type: 'link', fields: { url: 'https://x' }, children: [{ type: 'text', text: 'hier' }] },
      ] },
    ])
    expect(lexicalToPlainText(withLink)).toBe('siehe hier')
  })

  it('turns a linebreak node into a newline', () => {
    const br = state([{ type: 'paragraph', children: [
      { type: 'text', text: 'Zeile 1' }, { type: 'linebreak' }, { type: 'text', text: 'Zeile 2' },
    ] }])
    expect(lexicalToPlainText(br)).toBe('Zeile 1\nZeile 2')
  })

  it('returns empty string for missing/empty/garbage input', () => {
    expect(lexicalToPlainText(null)).toBe('')
    expect(lexicalToPlainText(undefined)).toBe('')
    expect(lexicalToPlainText({})).toBe('')
    expect(lexicalToPlainText({ root: {} })).toBe('')
    expect(lexicalToPlainText(state([]))).toBe('')
  })
})
```

`tests/unit/fotobuch-title.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { fotobuchTitle, fotobuchDateRange } from '@/lib/fotobuch-title'

describe('fotobuchTitle', () => {
  it('is the subject name, umlauts intact', () => {
    expect(fotobuchTitle({ type: 'person', name: 'Jürgen Müller' })).toBe('Jürgen Müller')
  })
})

describe('fotobuchDateRange', () => {
  it('event: fuzzy-date label', () => {
    expect(fotobuchDateRange({ type: 'event', name: 'Sommerlager', datePrecision: 'year', dateValue: '1989' })).toBe('1989')
    expect(fotobuchDateRange({ type: 'event', name: 'x', datePrecision: 'exact', dateValue: '1989-08-12' })).toBe('12.08.1989')
    expect(fotobuchDateRange({ type: 'event', name: 'x', datePrecision: 'decade', dateValue: '1980' })).toBe('1980er Jahre')
  })
  it('series: min–max of member-event years', () => {
    expect(fotobuchDateRange({ type: 'series', name: 'Sommerlager', years: [1990, 1985, 2025] })).toBe('1985–2025')
    expect(fotobuchDateRange({ type: 'series', name: 'x', years: [1999] })).toBe('1999')
    expect(fotobuchDateRange({ type: 'series', name: 'x', years: [] })).toBe('')
  })
  it('person: birth year or empty', () => {
    expect(fotobuchDateRange({ type: 'person', name: 'x', birthYear: 1974 })).toBe('* 1974')
    expect(fotobuchDateRange({ type: 'person', name: 'x' })).toBe('')
  })
})
```

- [ ] **Step 2: Run both — must fail** (unresolved modules).

- [ ] **Step 3: Implement `src/lib/lexical-text.ts`**:

```typescript
// Lexical (SerializedEditorState) → plain text for the PDF. v1 fidelity is deliberately narrow
// (spec §6.4): paragraphs and line breaks only — no bold/italic, no list markers, link TEXT kept
// but its url dropped. Enough for a printed story; richer typography is a later-phase item. Pure,
// so it lives in src/lib and is covered by test:unit's src/lib/** include.
type LexNode = { type?: string; text?: string; children?: unknown; [k: string]: unknown }

function nodeText(node: LexNode): string {
  if (node.type === 'linebreak') return '\n'
  if (typeof node.text === 'string') return node.text
  if (Array.isArray(node.children)) return (node.children as LexNode[]).map(nodeText).join('')
  return ''
}

export function lexicalToPlainText(state: unknown): string {
  const root = (state as { root?: LexNode } | null | undefined)?.root
  if (!root || !Array.isArray(root.children)) return ''
  const blocks: string[] = []
  for (const child of root.children as LexNode[]) {
    const text = nodeText(child).trim()
    if (text) blocks.push(text)
  }
  return blocks.join('\n\n')
}
```

- [ ] **Step 4: Implement `src/lib/fotobuch-title.ts`**:

```typescript
import { parseFuzzyDate, type FuzzyPrecision } from '@/lib/fuzzy-date'

export type FotobuchSubject =
  | { type: 'event'; name: string; datePrecision?: string | null; dateValue?: string | null }
  | { type: 'series'; name: string; years: number[] }
  | { type: 'person'; name: string; birthYear?: number | null }

export function fotobuchTitle(s: FotobuchSubject): string {
  return s.name
}

// Subtitle under the cover title (spec §6.2). Reuses parseFuzzyDate so an event's label reads
// exactly as it does on the event page. Series range is derived from its member events' years
// (computed by the caller, which has the events loaded).
export function fotobuchDateRange(s: FotobuchSubject): string {
  switch (s.type) {
    case 'event':
      return parseFuzzyDate({ precision: (s.datePrecision ?? 'unknown') as FuzzyPrecision, value: s.dateValue ?? null }).label
    case 'series': {
      const ys = s.years.filter((y) => Number.isFinite(y))
      if (ys.length === 0) return ''
      const min = Math.min(...ys)
      const max = Math.max(...ys)
      return min === max ? String(min) : `${min}–${max}`
    }
    case 'person':
      return s.birthYear ? `* ${s.birthYear}` : ''
  }
}
```

- [ ] **Step 5: Run both tests — must pass.** `pnpm exec tsc --noEmit` + `pnpm lint` clean. **Commit** — `feat: fotobuch pure helpers (lexicalToPlainText, title/date-range formatting)`

---

### Task 4: Image transcode + the React-PDF document builder

**Files:**
- Create: `src/lib/fotobuch-image.ts`
- Create: `src/lib/fotobuch-document.tsx`

**Interfaces:**
- Produces: `photoToJpegBuffer(photo, logger?): Promise<Buffer | null>`; `type FotobuchBook`, `type FotobuchPhoto`, `type FotobuchHistory`, `renderFotobuchPdf(book: FotobuchBook): Promise<Buffer>`. Task 5 imports these.
- The document builder does **no data fetching and no access control** — it takes an already-consent-filtered `FotobuchBook` of plain data + image buffers, keeping the safety boundary entirely in Task 2/Task 5.

- [ ] **Step 1: `src/lib/fotobuch-image.ts`** — on-disk read (the established `detectFaces.ts` / kiosk-image pattern) + `sharp` transcode:

```typescript
import path from 'node:path'
import { promises as fs } from 'node:fs'
import sharp from 'sharp'
import type { Payload } from 'payload'

type PhotoLike = {
  id: number | string
  filename?: string | null
  sizes?: { web?: { filename?: string | null } | null } | null
}

// Same resolution as src/jobs/detectFaces.ts and the kiosk image route: Photos has no staticDir
// override, so files live under <cwd>/photos. Prefer the 1600px `web` derivative (plenty for a
// 1200px print image and far cheaper to decode than a 40MP scan); fall back to the original.
// path.basename() strips any separators before the join (defense-in-depth, as the kiosk routes do).
function resolveFile(photo: PhotoLike): string | null {
  const dir = path.resolve(process.cwd(), 'photos')
  const web = photo.sizes?.web?.filename
  if (web) return path.join(dir, path.basename(web))
  if (photo.filename) return path.join(dir, path.basename(photo.filename))
  return null
}

/**
 * A print-bounded JPEG buffer for one photo, or null if the file is missing/undecodable.
 *
 * Transcoding through sharp (already a dep) does three jobs at once: it bakes EXIF orientation,
 * bounds the embedded image to a print-sensible size, and — crucially — GUARANTEES a JPEG, which
 * @react-pdf/renderer's jay-peg decoder reads reliably. @react-pdf/image cannot decode WebP/TIFF
 * and mishandles some PNGs, so feeding it raw derivative bytes would silently drop those photos;
 * always transcoding closes that gap (spec §5, §6.3). A missing/undecodable file is a SOFT skip
 * (logged, that photo omitted) — one bad file must never fail the whole book.
 */
export async function photoToJpegBuffer(photo: PhotoLike, logger?: Payload['logger']): Promise<Buffer | null> {
  const file = resolveFile(photo)
  if (!file) return null
  try {
    const bytes = await fs.readFile(file)
    return await sharp(bytes).rotate().resize({ width: 1200, withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer()
  } catch (err) {
    logger?.info({ msg: 'fotobuch-image-skipped', photoId: photo.id, reason: err instanceof Error ? err.message : String(err) })
    return null
  }
}
```

- [ ] **Step 2: `src/lib/fotobuch-document.tsx`** — the react-pdf document. Built-in Helvetica (WinAnsi) covers German umlauts + en-dash, so no embedded font (spec §5).

```tsx
import { Document, Page, View, Text, Image, StyleSheet, renderToBuffer } from '@react-pdf/renderer'

// A ready-to-render image buffer, or null (missing file → cell/cover omitted).
export type FotobuchImage = { data: Buffer; format: 'jpg' } | null

export type FotobuchPhoto = { image: FotobuchImage; caption: string | null; dateLabel: string }

export type FotobuchHistory = {
  gruppenHeading: string
  memberships: string[] // preformatted "Sippe Rotmilan · Sippenführer · 1985–1989"
  ereignisseHeading: string
  events: string[]
}

export type FotobuchBook = {
  title: string
  subtitle: string
  cover: FotobuchImage
  storyHeading: string
  story: string // plain text (event story / series description / person bio); '' → section omitted
  history: FotobuchHistory | null // person book only
  photos: FotobuchPhoto[]
  photosHeading: string
  emptyPhotosLabel: string
  truncatedNote: string | null
  footer: string
}

const styles = StyleSheet.create({
  cover: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 48 },
  coverImage: { width: '100%', height: 320, objectFit: 'cover', marginBottom: 24 },
  title: { fontSize: 30, textAlign: 'center', marginBottom: 8 },
  subtitle: { fontSize: 14, color: '#555', textAlign: 'center' },
  footer: { position: 'absolute', bottom: 24, left: 48, right: 48, textAlign: 'center', fontSize: 9, color: '#999' },
  page: { paddingVertical: 40, paddingHorizontal: 48 },
  heading: { fontSize: 18, marginBottom: 10, marginTop: 6 },
  story: { fontSize: 11, lineHeight: 1.5, marginBottom: 6 },
  listItem: { fontSize: 11, lineHeight: 1.5, marginBottom: 2 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: { width: '50%', padding: 6 },
  cellImage: { width: '100%', height: 200, objectFit: 'contain', backgroundColor: '#f2f2f2' },
  caption: { fontSize: 9, marginTop: 3 },
  date: { fontSize: 8, color: '#777' },
  note: { fontSize: 9, color: '#999', marginTop: 8 },
})

export async function renderFotobuchPdf(book: FotobuchBook): Promise<Buffer> {
  const doc = (
    <Document title={book.title}>
      {/* Cover */}
      <Page size="A4">
        <View style={styles.cover}>
          {book.cover && <Image style={styles.coverImage} src={book.cover} />}
          <Text style={styles.title}>{book.title}</Text>
          {book.subtitle ? <Text style={styles.subtitle}>{book.subtitle}</Text> : null}
          {book.truncatedNote ? <Text style={styles.note}>{book.truncatedNote}</Text> : null}
        </View>
        <Text style={styles.footer}>{book.footer}</Text>
      </Page>

      {/* Story / bio + person history */}
      {(book.story || book.history) && (
        <Page size="A4" style={styles.page}>
          {book.story ? (
            <View>
              <Text style={styles.heading}>{book.storyHeading}</Text>
              {book.story.split('\n\n').map((para, i) => (
                <Text key={`p${i}`} style={styles.story}>{para}</Text>
              ))}
            </View>
          ) : null}
          {book.history ? (
            <View>
              <Text style={styles.heading}>{book.history.gruppenHeading}</Text>
              {book.history.memberships.map((m, i) => (
                <Text key={`m${i}`} style={styles.listItem}>{m}</Text>
              ))}
              <Text style={styles.heading}>{book.history.ereignisseHeading}</Text>
              {book.history.events.map((e, i) => (
                <Text key={`e${i}`} style={styles.listItem}>{e}</Text>
              ))}
            </View>
          ) : null}
        </Page>
      )}

      {/* Photo grid — react-pdf paginates automatically via wrap */}
      <Page size="A4" style={styles.page} wrap>
        <Text style={styles.heading}>{book.photosHeading}</Text>
        {book.photos.length === 0 ? (
          <Text style={styles.story}>{book.emptyPhotosLabel}</Text>
        ) : (
          <View style={styles.grid}>
            {book.photos.map((p, i) => (
              <View key={`ph${i}`} style={styles.cell} wrap={false}>
                {p.image && <Image style={styles.cellImage} src={p.image} />}
                {p.caption ? <Text style={styles.caption}>{p.caption}</Text> : null}
                <Text style={styles.date}>{p.dateLabel}</Text>
              </View>
            ))}
          </View>
        )}
        <Text style={styles.footer}>{book.footer}</Text>
      </Page>
    </Document>
  )
  return renderToBuffer(doc)
}
```

- [ ] **Step 3: Verify** — `pnpm exec tsc --noEmit` clean (JSX in `.tsx`; the repo already builds React 19 TSX). `pnpm lint` clean. A quick smoke: temporarily import `renderFotobuchPdf` in a scratch `node --import tsx` snippet with an empty-photos book and assert the buffer starts with `%PDF-` — then delete the scratch (or rely on Task 5's int test, which covers this). **Commit** — `feat: fotobuch image transcode + react-pdf document builder`

---

### Task 5: The generate endpoint + integration safety tests

**Files:**
- Create: `src/app/api/fotobuch/route.ts`
- Modify: `src/messages/de.ts` (add `de.fotobuch` group — the German strings the endpoint & page use)
- Test: `tests/int/fotobuch.int.test.ts`

**Interfaces:**
- Consumes: `getUser`, `collectFotobuchPhotos`/`FotobuchTargetType`, `photoToJpegBuffer`, `renderFotobuchPdf`/`FotobuchBook`, `fotobuchDateRange`, `lexicalToPlainText`, `parseFuzzyDate`, `formatRange`, `de`.
- Produces: `POST /api/fotobuch` → `application/pdf` attachment, or 401/403/400.

- [ ] **Step 1: Add `de.fotobuch`** to `src/messages/de.ts` (inside the top-level object, e.g. after the `photos:` group). Also add a nav-independent link label:

```typescript
  fotobuch: {
    title: 'Fotobuch erstellen',
    hint: 'Wähle ein Ereignis, eine Reihe oder eine Person. Das Buch enthält nur öffentlich freigegebene Fotos; einzelne Fotos lassen sich vor dem Erzeugen ausschließen.',
    createBook: 'Buch erstellen',
    exclude: 'Ausschließen',
    generate: 'PDF erzeugen',
    generating: 'wird erzeugt …',
    error: 'Das hat nicht geklappt — bitte erneut versuchen.',
    empty: 'Für dieses Ziel sind keine Fotos freigegeben.',
    emptyPhotos: 'Keine Fotos.',
    storyEvent: 'Geschichte',
    storySeries: 'Beschreibung',
    storyPerson: 'Über',
    gruppen: 'Gruppen',
    ereignisse: 'Ereignisse',
    fotos: 'Fotos',
    footer: 'Stamm-Greif-Archiv',
    truncated: 'Es werden nur die ersten 300 Fotos angezeigt.',
    refusedHidden: 'Für eine verborgene Person kann kein Fotobuch erstellt werden.',
  },
```

- [ ] **Step 2: Implement `src/app/api/fotobuch/route.ts`**:

```typescript
import { getPayload } from 'payload'
import config from '@payload-config'
import { getUser } from '@/lib/get-user'
import { collectFotobuchPhotos, FOTOBUCH_MAX_PHOTOS, type FotobuchTargetType } from '@/lib/fotobuch-query'
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
  const photos = await collectFotobuchPhotos(payload, { type, id, excludeIds })

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
```

NOTE for the implementer: verify the generated `@/payload-types` field names used here against `src/payload-types.ts` before running (`m.vonYear`/`m.bisYear`/`m.role` on Membership, `a.event` on Attendance, `event.datePrecision`/`event.dateValue`/`event.story`, `series.description`, `person.bio`/`person.birthYear`/`person.hidden`). They match the collections read while writing this plan, but generated types are the source of truth — adjust casing if Payload pluralised/renamed anything.

- [ ] **Step 3: Write the int test** — `tests/int/fotobuch.int.test.ts`. Uses the Local API for the consent-SET assertions (deterministic, no PDF parsing) and `fetch` against the running dev server for the endpoint/role/PDF assertions — the same dual pattern the other int suites use (see `tests/int/kiosk.int.test.ts` / `invites.int.test.ts` headers for the running-server setup on the TEST database).

```typescript
// Integration: the fotobuch consent property (spec §3) is the point — a hidden-person photo never
// enters a book even when NOT excluded, a hidden person gets no book, exclude only removes, drafts
// and binned photos are absent, and a valid target yields a real PDF. Needs the dev server running
// against the TEST database (same setup as kiosk.int.test.ts).
import { describe, it, expect, beforeAll } from 'vitest'
import { getPayload, type Payload } from 'payload'
import config from '@payload-config'
import { collectFotobuchPhotos } from '@/lib/fotobuch-query'

let payload: Payload
let kuratorEmail: string
let memberEmail: string
const password = 'geheim123'

let eventId: number
let visiblePhotoId: number
let hiddenPersonPhotoId: number
let draftPhotoId: number
let binnedPhotoId: number
let hiddenPersonId: number

async function loginCookie(email: string): Promise<string> {
  const res = await fetch('http://localhost:3000/api/users/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  expect(res.ok).toBe(true)
  return res.headers.get('set-cookie') ?? ''
}

beforeAll(async () => {
  payload = await getPayload({ config: await config })
  const stamp = Date.now()
  kuratorEmail = `fb-kurator${stamp}@example.com`
  memberEmail = `fb-member${stamp}@example.com`
  await payload.create({ collection: 'users', data: { name: 'FB Kurator', email: kuratorEmail, password, role: 'kurator' }, overrideAccess: true })
  await payload.create({ collection: 'users', data: { name: 'FB Member', email: memberEmail, password, role: 'mitglied' }, overrideAccess: true })

  const hidden = await payload.create({ collection: 'people', data: { name: `Verborgen ${stamp}`, hidden: true }, overrideAccess: true })
  hiddenPersonId = hidden.id
  const event = await payload.create({ collection: 'events', data: { name: `Lager ${stamp}`, datePrecision: 'year', dateValue: '1989' }, overrideAccess: true })
  eventId = event.id

  // A clean published photo of the event.
  const visible = await payload.create({
    collection: 'photos',
    data: { caption: 'sichtbar', event: eventId, datePrecision: 'year', dateValue: '1989', _status: 'published' },
    filePath: 'tests/fixtures/gesicht.jpg', overrideAccess: true,
  })
  visiblePhotoId = visible.id

  // A published photo of the SAME event that also tags the hidden person → hasHiddenPerson recomputes true.
  const withHidden = await payload.create({
    collection: 'photos',
    data: { caption: 'hat verborgene Person', event: eventId, people: [hiddenPersonId], datePrecision: 'year', dateValue: '1989', _status: 'published' },
    filePath: 'tests/fixtures/gesicht.jpg', overrideAccess: true,
  })
  hiddenPersonPhotoId = withHidden.id

  const draft = await payload.create({
    collection: 'photos', data: { caption: 'entwurf', event: eventId, _status: 'draft' },
    filePath: 'tests/fixtures/gesicht.jpg', overrideAccess: true,
  })
  draftPhotoId = draft.id

  const binned = await payload.create({
    collection: 'photos', data: { caption: 'papierkorb', event: eventId, _status: 'published', deletedAt: new Date().toISOString() },
    filePath: 'tests/fixtures/gesicht.jpg', overrideAccess: true,
  })
  binnedPhotoId = binned.id
})

describe('collectFotobuchPhotos consent set (spec §3)', () => {
  it('includes the clean published photo, excludes hidden-person/draft/binned — WITHOUT any excludeIds', async () => {
    const set = await collectFotobuchPhotos(payload, { type: 'event', id: eventId })
    const ids = set.map((p) => p.id)
    expect(ids).toContain(visiblePhotoId)
    expect(ids).not.toContain(hiddenPersonPhotoId) // absent though never excluded — consent, not the exclude list
    expect(ids).not.toContain(draftPhotoId)
    expect(ids).not.toContain(binnedPhotoId)
  })

  it('excludeIds only removes: the clean photo drops out when excluded', async () => {
    const set = await collectFotobuchPhotos(payload, { type: 'event', id: eventId, excludeIds: [visiblePhotoId] })
    expect(set.map((p) => p.id)).not.toContain(visiblePhotoId)
  })

  it('excludeIds cannot re-admit a hidden-person photo (not present even when "un-excluded")', async () => {
    const set = await collectFotobuchPhotos(payload, { type: 'event', id: eventId, excludeIds: [] })
    expect(set.map((p) => p.id)).not.toContain(hiddenPersonPhotoId)
  })
})

describe('POST /api/fotobuch', () => {
  it('rejects a mitglied', async () => {
    const cookie = await loginCookie(memberEmail)
    const res = await fetch('http://localhost:3000/api/fotobuch', {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'event', id: eventId }),
    })
    expect(res.status).toBe(403)
  })

  it('rejects an unauthenticated request', async () => {
    const res = await fetch('http://localhost:3000/api/fotobuch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'event', id: eventId }),
    })
    expect(res.status).toBe(401)
  })

  it('refuses a person book for a hidden person', async () => {
    const cookie = await loginCookie(kuratorEmail)
    const res = await fetch('http://localhost:3000/api/fotobuch', {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'person', id: hiddenPersonId }),
    })
    expect(res.status).toBe(403)
  })

  it('produces a valid PDF for a kurator', async () => {
    const cookie = await loginCookie(kuratorEmail)
    const res = await fetch('http://localhost:3000/api/fotobuch', {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'event', id: eventId }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/pdf')
    expect(res.headers.get('content-disposition')).toContain('attachment')
    const buf = Buffer.from(await res.arrayBuffer())
    expect(buf.length).toBeGreaterThan(0)
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })
})
```

NOTE: `tests/fixtures/gesicht.jpg` already exists (added by P2.3 faces). Reusing it avoids a new fixture. If the photo `create` calls need a different field to attach a file in this repo's test setup, copy the exact shape from `tests/int/kiosk.int.test.ts`'s photo creation.

- [ ] **Step 4: Run** — start the app on the test DB (per the int-suite header), then `pnpm test:int` (or just this file). All new cases green; existing int suite still green. `pnpm exec tsc --noEmit` + `pnpm lint` clean. **Commit** — `feat: POST /api/fotobuch generate endpoint + consent-safety int tests`

---

### Task 6: Exclude UX — the `/fotobuch` page, client form, and entry links

**Files:**
- Create: `src/app/(frontend)/fotobuch/page.tsx`
- Create: `src/app/(frontend)/fotobuch/FotobuchForm.tsx`
- Modify: `src/app/(frontend)/ereignisse/[id]/page.tsx`, `src/app/(frontend)/personen/[id]/page.tsx` (a „Buch erstellen" link)

**Interfaces:** consumes `de.fotobuch`, `collectFotobuchPhotos`, `getUser`. The page fetches through the SAME `collectFotobuchPhotos` filter, so a hidden-person photo of the subject is not even listed for exclusion.

- [ ] **Step 1: `src/app/(frontend)/fotobuch/page.tsx`** (server component, kurator/admin-gated exactly like `/gesichter`):

```tsx
import { getPayload } from 'payload'
import config from '@payload-config'
import { notFound, redirect } from 'next/navigation'
import { getUser } from '@/lib/get-user'
import { de } from '@/messages/de'
import { collectFotobuchPhotos, type FotobuchTargetType } from '@/lib/fotobuch-query'
import { FotobuchForm } from './FotobuchForm'
import type { Photo } from '@/payload-types'

export const dynamic = 'force-dynamic'

export default async function FotobuchPage({ searchParams }: { searchParams: Promise<{ type?: string; id?: string }> }) {
  const user = await getUser()
  if (!user) redirect('/anmelden')
  if (user.role !== 'admin' && user.role !== 'kurator') notFound()

  const { type, id } = await searchParams
  const parsedId = Number(id)
  const validType = type === 'event' || type === 'series' || type === 'person'
  if (!validType || !Number.isFinite(parsedId)) {
    return (
      <>
        <h1>{de.fotobuch.title}</h1>
        <p>{de.fotobuch.hint}</p>
      </>
    )
  }

  const payload = await getPayload({ config })
  const photos = await collectFotobuchPhotos(payload, { type: type as FotobuchTargetType, id: parsedId })

  return (
    <>
      <h1>{de.fotobuch.title}</h1>
      <p>{de.fotobuch.hint}</p>
      <FotobuchForm
        type={type as FotobuchTargetType}
        id={parsedId}
        photos={(photos as Photo[]).map((p) => ({
          id: p.id,
          caption: p.caption ?? null,
          thumbUrl: p.sizes?.thumbnail?.url ?? p.url ?? null,
        }))}
      />
    </>
  )
}
```

- [ ] **Step 2: `src/app/(frontend)/fotobuch/FotobuchForm.tsx`** (`'use client'`, the `FaceReviewForm`/`KioskAdmin` shape — re-entrancy guard, German strings, POSTs JSON, downloads the blob):

```tsx
'use client'
import { useState } from 'react'
import { de } from '@/messages/de'
import type { FotobuchTargetType } from '@/lib/fotobuch-query'

type PhotoRow = { id: number; caption: string | null; thumbUrl: string | null }

export function FotobuchForm({ type, id, photos }: { type: FotobuchTargetType; id: number; photos: PhotoRow[] }) {
  const [excluded, setExcluded] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function toggle(pid: number) {
    setExcluded((prev) => {
      const next = new Set(prev)
      next.has(pid) ? next.delete(pid) : next.add(pid)
      return next
    })
  }

  async function generate() {
    if (busy) return // re-entrancy guard (UploadForm/FaceReviewForm pattern)
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/fotobuch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, id, excludeIds: Array.from(excluded) }),
      })
      if (!res.ok) throw new Error(String(res.status))
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'fotobuch.pdf' // the server's Content-Disposition filename wins where honoured
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch {
      setError(de.fotobuch.error)
    } finally {
      setBusy(false)
    }
  }

  if (photos.length === 0) return <p>{de.fotobuch.empty}</p>

  return (
    <div>
      <ul style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', listStyle: 'none', padding: 0 }}>
        {photos.map((p) => (
          <li key={p.id} style={{ width: 140 }}>
            {p.thumbUrl && <img src={p.thumbUrl} alt={p.caption ?? ''} style={{ width: '100%', opacity: excluded.has(p.id) ? 0.35 : 1 }} />}
            <label style={{ fontSize: '0.8rem', display: 'block' }}>
              <input type="checkbox" checked={excluded.has(p.id)} onChange={() => toggle(p.id)} /> {de.fotobuch.exclude}
            </label>
          </li>
        ))}
      </ul>
      <button onClick={generate} disabled={busy}>{busy ? de.fotobuch.generating : de.fotobuch.generate}</button>
      {error && <p role="alert">{error}</p>}
    </div>
  )
}
```

- [ ] **Step 3: Entry links.** In `ereignisse/[id]/page.tsx`, add near the `<h1>` (kurator-only, since only they may generate):

```tsx
{isKurator && <p><Link href={`/fotobuch?type=event&id=${id}`}>{de.fotobuch.createBook}</Link></p>}
```

In `personen/[id]/page.tsx`, add the analogous link — but only when the person is **not hidden** (a hidden person gets no book, §3), and it is already gated to kurator via `isKurator`:

```tsx
{isKurator && !person.hidden && <p><Link href={`/fotobuch?type=person&id=${id}`}>{de.fotobuch.createBook}</Link></p>}
```

(EventSeries has no dedicated page in this app; series books are reachable via `/fotobuch?type=series&id=…` directly. No new page needed.)

- [ ] **Step 4: Verify** — `pnpm exec tsc --noEmit` + `pnpm lint` clean; `pnpm test:unit` green; existing e2e journeys still green (`pnpm exec playwright test --workers=1` — the new links are additive and kurator-gated, no journey changes). **Commit** — `feat: /fotobuch exclude page + client form + Buch-erstellen entry links`

---

### Task 7: Docs, build verification, ship

**Files:**
- Modify: `docs/betrieb.md` (new „Fotobuch (PDF-Export)" section)
- Modify: `.github/workflows/ci.yml` (docker-job render verification)

- [ ] **Step 1: `betrieb.md` „Fotobuch (PDF-Export)" section** — slot it after „Kiosk & Zeitleiste" (line ~345) and before „Monitoring", in the file's existing German shape (copy-pasteable steps, **bold** for the consent rule):

```markdown
## Fotobuch (PDF-Export)

Kurator:innen und Admins erzeugen aus einem Ereignis, einer Ereignisreihe oder einer Person ein
druckfertiges A4-PDF (Titel, Geschichte/Notizen, Fotoraster in Datumsreihenfolge; das Personen-Buch
enthält zusätzlich die Gruppen- und Ereignis-Geschichte der Person).

**So geht's:** Auf einer Ereignis- oder Personenseite „Buch erstellen" wählen (oder direkt
`/fotobuch?type=event&id=…` bzw. `type=series` / `type=person` öffnen). Einzelne Fotos lassen sich
per Häkchen „Ausschließen" weglassen. „PDF erzeugen" lädt die Datei herunter.

**Konsens-Regel (wichtig):** Das Buch enthält **ausschließlich veröffentlichte, nicht verborgene
und nicht gelöschte Fotos** — und zwar unabhängig davon, wer es erzeugt. Ein Kurator sieht in der
App zwar auch Fotos verborgener Personen; im PDF erscheinen sie **nie**, denn die Datei verlässt das
System und bekommt denselben Konsens-Maßstab wie der öffentliche Beamer. **Ein Foto einer
verborgenen Person taucht in keinem Buch auf — auch dann nicht, wenn es nicht ausdrücklich
ausgeschlossen wurde — und für eine verborgene Person lässt sich gar kein Buch erstellen.**
Das Ausschließen kann nur weglassen, niemals etwas hinzufügen.

**Ein paar bewusste Einschränkungen:**
- Höchstens 300 Fotos pro Buch (älteste zuerst; bei mehr wird auf dem Titel darauf hingewiesen).
- Die Geschichte wird als **einfacher Text** übernommen (kein Fett/Kursiv, keine Links/Listen in v1).
- Das Titelbild wird automatisch gewählt (das älteste Foto); Umsortieren/Neuanordnen kommt später.
- Fotos werden für den Druck verkleinert eingebettet.

**Technik:** Der Export läuft im laufenden App-Prozess über `@react-pdf/renderer` — kein Browser,
kein zusätzlicher Container, keine zusätzliche RAM-Stufe (nur die üblichen paar MB je Buch während
der Erzeugung). Ein 2-GB-VPS reicht weiterhin.
```

- [ ] **Step 2: docker-job render verification** in `.github/workflows/ci.yml` — after the existing "Verify onnxruntime-web wasm is shipped" step, add a step that runs the render probe inside the built standalone image (proving yoga's wasm/asm asset was traced in):

```yaml
      - name: Verify @react-pdf/renderer renders in the built image
        run: |
          docker compose run --rm --no-deps --entrypoint sh app -c \
            'node /app/scripts/probe-fotobuch.mjs'
```

If this step fails with a yoga/wasm resolution error, add the `outputFileTracingIncludes` entry deferred in Task 1 Step 3 (the yoga-layout wasm/asm asset under `node_modules/yoga-layout`), rebuild, and re-run — then it must pass. (Adjust the exact `docker compose run` invocation to match how the other docker-job steps in this file exec inside the image; the point is: run `scripts/probe-fotobuch.mjs` against the production build, not host `node_modules`.)

- [ ] **Step 3: Full local gate** — `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm test:unit`, int suite (app on test DB), `pnpm exec playwright test --workers=1`. All green.

- [ ] **Step 4: Ship** — push `p2-fotobuch`, open PR (base `main`) summarising the spec: in-process react-pdf (no browser/container), consent HARD on output, request-scoped excludes, sync+capped. CI must go green (`test`, `e2e`, `docker` incl. the render verification, `hygiene`, drift check clean). Address CodeRabbit; resolve all threads.

- [ ] **Step 5: USER GATE** — ask before merging.

- [ ] **Step 6: After merge** — redeploy the stack (`docker compose build` then up per betrieb.md; migrations are a no-op here — no schema). Smoke: as a kurator, `POST /api/fotobuch { type:'event', id:<real> }` returns a `%PDF-` attachment; open it and confirm cover + photos render with umlauts. Report the smoke result.

---

## Self-review (done at write time)

- **Spec coverage:** every spec section maps to a task — engine assessment/build (§5 → T1), consent filter+builder (§3,§4 → T2), pure helpers (§6.2,§6.4 → T3), document+images (§6.1,§6.3 → T4), endpoint+refusal+consent+tests (§3,§7,§10 → T5), exclude UX (§8 → T6), rollout+betrieb+CI (§11 → T7).
- **No placeholders:** all module code is complete and importable; the only marked "verify against generated types" note (T5 Step 2) is an explicit correctness check on field casing, not a gap.
- **Consent-safety coverage:** the filter exists once (`fotobuchPhotoWhere`, T2), is reached once (`collectFotobuchPhotos`, T2), used by both endpoint (T5) and page (T6); `overrideAccess:true` is paired with it everywhere; `excludeIds` only subtracts (T2 code + T5 body handling); hidden-person refusal is enforced in the endpoint (T5) and the person-page link is suppressed for hidden subjects (T6); the int tests pin: hidden-person-photo-absent-without-exclude, exclude-only-removes, hidden-person-book-refused, draft/binned absent, valid PDF (T5 Step 3).
- **Type consistency:** `FotobuchTargetType` ('event'|'series'|'person') is shared across query/endpoint/page; `FotobuchImage`/`FotobuchBook`/`FotobuchPhoto`/`FotobuchHistory` flow builder→endpoint unchanged; `collectFotobuchPhotos(payload, args): Promise<Photo[]>` signature identical at every call and test site.
- **No schema/migration:** stated in Global Constraints and §9; drift check must stay clean — nothing in the plan touches collections or fields.
- **House-style match:** header + agentic-worker note + Global Constraints + numbered tasks with Files/Interfaces/Steps, complete code, exact commands, and a commit line per task — matching `2026-08-06-telemetry-logging.md` and the P2.3/P2.4 plans.
</content>
