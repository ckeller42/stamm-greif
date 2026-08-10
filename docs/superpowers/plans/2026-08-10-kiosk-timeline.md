# Kiosk Mode + Timeline/Series Scrub — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A curated, unauthenticated, signed-link kiosk slideshow with per-photo QR downloads for the 2027 Fest, plus an in-app members-only timeline that scrubs an `EventSeries` year by year — both enforcing the existing photo-consent model and never bypassing it.

**Architecture:** Kiosk auth is a signed link (HMAC over a key derived from `PAYLOAD_SECRET`, expiry embedded) plus per-photo signed download tokens; a `KioskSession` record gives per-link revocation. The single consent filter `kioskPhotoWhere()` (published + not-hidden + not-binned + `kioskFreigegeben`) is shared by the slideshow fetch and the download re-check, so the allowlist is only ever an *extra restriction*. The timeline is a plain authed page using `overrideAccess:false` + `user`, so `canReadPhoto` enforces consent for free. QR is a vendored pure-TS encoder (no new npm dep) emitting inline SVG server-side.

**Tech Stack:** Next.js 16 route handlers + route groups, Payload 3.87 collection + field access, Node `crypto` (HMAC-SHA256, `timingSafeEqual`), `migrate:create` migrations, vendored MIT QR generator.

**Spec:** `docs/superpowers/specs/2026-08-10-kiosk-timeline-design.md`

## Global Constraints

- Branch `p2-kiosk-spec` (this spec + plan are committed on it; feature work continues here or on a fresh branch off it). Every commit ends with the two trailer lines shown by `git log -1 --format=%B` on a non-merge commit of this repo:
  ```
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01JC1txEMwUTwmR5dhGSXWaG
  ```
- **The one safety property (spec §3):** on every kiosk surface a photo is served only if `kioskFreigegeben == true AND _status == 'published' AND hasHiddenPerson != true AND deletedAt does not exist`, evaluated at request time. `kioskPhotoWhere()` is the sole expression of it; no kiosk code path builds that `where` inline, and no code reads a kiosk photo with `overrideAccess:true` without it.
- German UI strings live in `src/messages/de.ts` — never hardcode German in components.
- Signing key is **derived**, never raw: `kioskKey = crypto.createHmac('sha256','kiosk-v1').update(PAYLOAD_SECRET).digest()` is wrong-way-round; use `crypto.createHmac('sha256', PAYLOAD_SECRET).update('kiosk-v1').digest()`. Verification compares with `crypto.timingSafeEqual` after a length guard. `verifyKioskToken` never throws.
- Token/consent order everywhere: verify signature+`exp` (stateless) → load+check `KioskSession` (revoked/expired) → `kioskPhotoWhere()` consent filter. Cheapest, most-attacker-facing check first.
- All existing tests stay green (8 unit files, int suite, 3 e2e). `pnpm exec tsc --noEmit` and `pnpm lint` clean after every task. New unit tests live under `tests/unit`, int under `tests/int`, and only `src/lib/**` counts toward coverage (see `test:unit`'s `--coverage.include`).
- Migrations via `pnpm payload migrate:create`; commit the generated `.ts`+`.json`; CI drift check (`migrate:create ci_drift_check --skip-empty`) must produce nothing.
- `KIOSK_LINK_TTL_HOURS` default `12`, parsed with the same blank-string guard `src/lib/faces.ts` uses.
- Uploads on disk: `path.resolve(process.cwd(),'photos', filename)` (Photos has no `staticDir` override — same resolution `src/jobs/detectFaces.ts` relies on).

---

### Task 1: Schema — `kioskFreigegeben` field + `kiosk-sessions` collection + migration

**Files:**
- Modify: `src/collections/Photos.ts` (add `kioskFreigegeben` field)
- Create: `src/collections/KioskSessions.ts`
- Modify: `src/payload.config.ts` (register collection)
- Modify: `src/messages/de.ts` (field label/help — used in admin `description`)
- Create migration: `src/migrations/<ts>_kiosk.ts` + `.json`

**Interfaces produced:** `photos.kioskFreigegeben: boolean`; collection slug `kiosk-sessions` with fields `label, expiresAt, revokedAt, createdBy`. Tasks 4–6 depend on both.

- [ ] **Step 1: Add the field to `Photos.ts`.** Reuse the existing `isKuratorOrAdminField` predicate already defined in that file. Insert after the `duplicateSuspected` field:

```typescript
    // P2.4 (kiosk allowlist). A kurator/admin explicitly marks a photo kiosk-safe; ONLY marked
    // photos are eligible for the public beamer — and even then only if they still pass every
    // other consent gate (see src/lib/kiosk-query.ts's kioskPhotoWhere(): this flag is always an
    // extra AND term, never a bypass). Read is open (the boolean is harmless); writes are
    // kurator/admin-only, the same gate as duplicate/exif fields above. The human rule the flag
    // encodes — never mark member-only/minor photos for the public beamer — lives in the admin
    // help text and betrieb.md; the code can only enforce "marked AND still-consented", not the
    // curator's judgement about which photos are safe to mark.
    {
      name: 'kioskFreigegeben',
      type: 'checkbox',
      defaultValue: false,
      label: de.photos.kioskFreigegeben.label,
      admin: { description: de.photos.kioskFreigegeben.help, position: 'sidebar' },
      access: { create: isKuratorOrAdminField, update: isKuratorOrAdminField },
    },
```

Add `import { de } from '@/messages/de'` at the top of `Photos.ts` if not already present (it is not — add it).

- [ ] **Step 2: Add the de strings.** In `src/messages/de.ts`, add a top-level `photos` block:

```typescript
  photos: {
    kioskFreigegeben: {
      label: 'Für Kiosk freigegeben',
      help: 'Nur für den öffentlichen Beamer/Kiosk freigeben, was wirklich öffentlich gezeigt ' +
        'werden darf. Niemals Fotos von Minderjährigen oder mitglieder-interne Fotos markieren — ' +
        'der Kiosk ist ohne Anmeldung sichtbar. Verborgene, unveröffentlichte oder gelöschte ' +
        'Fotos erscheinen ohnehin nie, auch wenn sie hier markiert sind.',
    },
  },
```

- [ ] **Step 3: Create `src/collections/KioskSessions.ts`:**

```typescript
import type { CollectionConfig } from 'payload'
import { isAdmin } from '@/access/roles'

// P2.4 — one row per minted kiosk link. This is the revocation + audit story: a signed kiosk/
// download token embeds this row's id (`sid`); every kiosk request loads the row and rejects if
// it is missing, `revokedAt` is set, or `expiresAt` has passed. Revoke = one field write, no
// secret rotation, no member-login impact. Admin-only CRUD (same posture as Invites); kurators
// mint/revoke through /api/kiosk/session, which runs overrideAccess:true.
export const KioskSessions: CollectionConfig = {
  slug: 'kiosk-sessions',
  labels: { singular: 'Kiosk-Sitzung', plural: 'Kiosk-Sitzungen' },
  admin: { useAsTitle: 'label', group: 'Verwaltung', defaultColumns: ['label', 'expiresAt', 'revokedAt'] },
  access: { read: isAdmin, create: isAdmin, update: isAdmin, delete: isAdmin },
  fields: [
    { name: 'label', type: 'text', label: 'Bezeichnung' },
    { name: 'expiresAt', type: 'date', required: true, label: 'Gültig bis' },
    { name: 'revokedAt', type: 'date', label: 'Widerrufen am', admin: { readOnly: true } },
    {
      name: 'createdBy',
      type: 'relationship',
      relationTo: 'users',
      admin: { readOnly: true },
      access: { update: () => false },
    },
  ],
}
```

- [ ] **Step 4: Register it** in `src/payload.config.ts`: import `KioskSessions` and add to the `collections` array (place after `Invites` in the `Verwaltung` group, e.g. `[Users, Invites, KioskSessions, People, …]`).

- [ ] **Step 5: Generate types + migration.** Run:
```sh
pnpm generate:types
docker compose -f docker-compose.dev.yml up -d db   # local dev DB on :5432 (see .env.example)
pnpm payload migrate:create kiosk
```
Confirm the generated `src/migrations/<ts>_kiosk.ts` adds `photos.kiosk_freigegeben` + `_photos_v.version_kiosk_freigegeben` (drafts table) and the `kiosk_sessions` table. Commit both `.ts` and `.json`.

- [ ] **Step 6: Verify** — `pnpm exec tsc --noEmit`, `pnpm lint` clean; `pnpm payload migrate:create ci_drift_check --skip-empty` produces **no** new file (drift-clean). **Commit** — `feat: kioskFreigegeben allowlist field + kiosk-sessions collection + migration`

---

### Task 2: Signed-token core + shared consent filter

**Files:**
- Create: `src/lib/kiosk-token.ts`
- Create: `src/lib/kiosk-query.ts`
- Test: `tests/unit/kiosk-token.test.ts`

**Interfaces produced:**
- `signKioskToken(payload: KioskTokenPayload): string`, `verifyKioskToken(token: string, kind: 'session' | 'download'): KioskTokenPayload | null`.
- `kioskPhotoWhere(): Where` — the sole consent filter. Tasks 4–5 import both.

- [ ] **Step 1: Write the failing unit test** `tests/unit/kiosk-token.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { signKioskToken, verifyKioskToken } from '@/lib/kiosk-token'

beforeEach(() => { process.env.PAYLOAD_SECRET = 'test-secret-abc' })

describe('kiosk-token', () => {
  it('round-trips a session token', () => {
    const t = signKioskToken({ sid: 42, exp: Date.now() + 60_000 })
    const v = verifyKioskToken(t, 'session')
    expect(v).toMatchObject({ sid: 42 })
  })

  it('round-trips a download token', () => {
    const t = signKioskToken({ sid: 1, pid: 7, exp: Date.now() + 60_000 })
    expect(verifyKioskToken(t, 'download')).toMatchObject({ sid: 1, pid: 7 })
  })

  it('rejects an expired token', () => {
    const t = signKioskToken({ sid: 1, exp: Date.now() - 1 })
    expect(verifyKioskToken(t, 'session')).toBeNull()
  })

  it('rejects a tampered payload', () => {
    const t = signKioskToken({ sid: 1, exp: Date.now() + 60_000 })
    const [p, s] = t.split('.')
    const forged = Buffer.from(JSON.stringify({ sid: 999, exp: Date.now() + 60_000 })).toString('base64url')
    expect(verifyKioskToken(`${forged}.${s}`, 'session')).toBeNull()
    expect(verifyKioskToken(`${p}.deadbeef`, 'session')).toBeNull()
  })

  it('rejects a wrong-secret signature', () => {
    const t = signKioskToken({ sid: 1, exp: Date.now() + 60_000 })
    process.env.PAYLOAD_SECRET = 'a-different-secret'
    expect(verifyKioskToken(t, 'session')).toBeNull()
  })

  it('rejects a kind mismatch (download token read as session and vice-versa)', () => {
    const dl = signKioskToken({ sid: 1, pid: 7, exp: Date.now() + 60_000 })
    expect(verifyKioskToken(dl, 'session')).toBeNull()
    const se = signKioskToken({ sid: 1, exp: Date.now() + 60_000 })
    expect(verifyKioskToken(se, 'download')).toBeNull()
  })

  it('never throws on garbage input', () => {
    for (const g of ['', 'x', 'a.b.c', '...', 'notbase64.@@@']) {
      expect(() => verifyKioskToken(g, 'session')).not.toThrow()
      expect(verifyKioskToken(g, 'session')).toBeNull()
    }
  })
})
```

- [ ] **Step 2: Run it — must fail** (`pnpm exec vitest run tests/unit/kiosk-token.test.ts`; cannot resolve `@/lib/kiosk-token`).

- [ ] **Step 3: Implement `src/lib/kiosk-token.ts`:**

```typescript
import crypto from 'crypto'

// P2.4 signed kiosk links + per-photo download tokens. Two token kinds share one HMAC primitive:
//   session  { sid, exp }        — the /kiosk?k= link
//   download { sid, pid, exp }   — one per photo QR, /api/kiosk/download?d=
// The signing key is DERIVED from PAYLOAD_SECRET, never the secret itself, so kiosk signatures
// are not interchangeable with any other use of the secret and carry a version handle ('kiosk-v1')
// for a future rotation that leaves member logins untouched.
export type KioskTokenPayload =
  | { sid: number; exp: number }
  | { sid: number; pid: number; exp: number }

function kioskKey(): Buffer {
  const secret = process.env.PAYLOAD_SECRET
  if (!secret) throw new Error('PAYLOAD_SECRET is required')
  return crypto.createHmac('sha256', secret).update('kiosk-v1').digest()
}

function sign(payloadB64: string): string {
  return crypto.createHmac('sha256', kioskKey()).update(payloadB64).digest('base64url')
}

export function signKioskToken(payload: KioskTokenPayload): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${payloadB64}.${sign(payloadB64)}`
}

// Verification order: shape → constant-time signature compare → expiry → kind. Never throws; any
// malformed/forged/expired/wrong-kind input returns null, which every caller maps to a 404 / the
// graceful invalid state. Statless (no DB) — this is the cheap, attacker-facing fast path;
// revocation and consent are checked by callers AFTER a token verifies.
export function verifyKioskToken(
  token: string,
  kind: 'session' | 'download',
): KioskTokenPayload | null {
  try {
    const dot = token.indexOf('.')
    if (dot <= 0) return null
    const payloadB64 = token.slice(0, dot)
    const sigB64 = token.slice(dot + 1)
    const expected = Buffer.from(sign(payloadB64), 'utf8')
    const got = Buffer.from(sigB64, 'utf8')
    if (expected.length !== got.length) return null
    if (!crypto.timingSafeEqual(expected, got)) return null
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as Record<string, unknown>
    if (typeof payload.sid !== 'number' || typeof payload.exp !== 'number') return null
    if (payload.exp <= Date.now()) return null
    const isDownload = typeof payload.pid === 'number'
    if (kind === 'download' && !isDownload) return null
    if (kind === 'session' && isDownload) return null
    return payload as KioskTokenPayload
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Implement `src/lib/kiosk-query.ts`:**

```typescript
import type { Where } from 'payload'

// P2.4 — THE consent filter for every unauthenticated kiosk surface (spec §3). The kiosk runs its
// photo queries with overrideAccess:true (there is no req.user, so canReadPhoto would return
// false and show nothing), which means the collection's own access control is deliberately
// bypassed — and this is the ONLY thing that keeps that safe. Every AND term here mirrors the
// "published" branch of canReadPhoto in src/collections/Photos.ts, PLUS the kiosk allowlist:
//
//   kioskFreigegeben == true   the curator's explicit opt-in (the human consent gate)
//   _status == 'published'     never a draft
//   hasHiddenPerson != true    never a hidden-person photo — the allowlist can't override this
//   deletedAt not exists       never a binned photo
//
// The allowlist is only ever an EXTRA restriction: it appears here inside an AND, never an OR.
// Imported by BOTH the /kiosk slideshow fetch and the /api/kiosk/download re-check so the two can
// never drift — do not inline this `where` anywhere. Changing it changes what the public beamer
// can show; the int tests in tests/int/kiosk.int.test.ts pin the safety property against it.
export function kioskPhotoWhere(): Where {
  return {
    and: [
      { kioskFreigegeben: { equals: true } },
      { _status: { equals: 'published' } },
      { hasHiddenPerson: { not_equals: true } },
      { deletedAt: { exists: false } },
    ],
  }
}
```

- [ ] **Step 5: Run the unit test — must pass** (all cases). `pnpm exec tsc --noEmit`, `pnpm lint` clean.

- [ ] **Step 6: Commit** — `feat: signed kiosk token lib (HMAC/expiry/timing-safe) + shared consent filter`

---

### Task 3: QR encoder (vendored pure-TS) → inline SVG

**Files:**
- Create: `src/lib/vendor/qr-codegen.ts` (vendored MIT source)
- Create: `src/lib/qr.ts` (wrapper)
- Test: `tests/unit/qr.test.ts`

**Interfaces produced:** `qrSvg(text: string, opts?: { margin?: number }): string` → a self-contained `<svg>` string. Task 5 embeds it per slide.

> **Note (called out in self-review):** this is the one task whose primary artifact is *vendored*, not written inline here. Pasting a ~600-line QR encoder into this plan would be error-prone and unreviewable. Vendor a single known-good MIT implementation instead; the wrapper and its test — the parts specific to this app — are given in full.

- [ ] **Step 1: Vendor the encoder.** Add `src/lib/vendor/qr-codegen.ts` = Nayuki's "QR Code generator library (TypeScript)" (MIT), the single-file `qrcodegen` module (class `QrCode` with `QrCode.encodeText(text, ecl)` and `.getModule(x,y)`/`.size`). Keep its MIT license header verbatim at the top of the file. Source of truth: the `qrcodegen` TypeScript reference implementation (single file, no dependencies). Add an ESLint-disable header line if its style trips the repo lint (`/* eslint-disable */` is acceptable for vendored code — note it in the commit). Do **not** add any npm dependency.

- [ ] **Step 2: Write the wrapper `src/lib/qr.ts`:**

```typescript
import { QrCode, QrSegment } from './vendor/qr-codegen'

// P2.4 — server-side QR → self-contained inline SVG for the kiosk slideshow. No npm dependency
// (vendored pure-TS encoder), no client-side QR code, no external asset — safe to inline under the
// app's CSP. Medium error correction tolerates a little beamer glare/skew on a phone camera.
export function qrSvg(text: string, opts: { margin?: number } = {}): string {
  const margin = opts.margin ?? 2
  const qr = QrCode.encodeSegments(QrSegment.makeSegments(text), QrCode.Ecc.MEDIUM)
  const size = qr.size + margin * 2
  let path = ''
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.getModule(x, y)) path += `M${x + margin},${y + margin}h1v1h-1z`
    }
  }
  // viewBox in module units; currentColor so the caller controls the colour. crispEdges keeps the
  // modules sharp at any scale on the beamer.
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" ` +
    `shape-rendering="crispEdges" role="img" aria-label="QR-Code zum Herunterladen">` +
    `<rect width="${size}" height="${size}" fill="#fff"/>` +
    `<path d="${path}" fill="#000"/></svg>`
  )
}
```

(Adjust the `QrCode.encodeSegments`/`QrSegment` calls to the exact API of the vendored file — some single-file variants expose `QrCode.encodeText(text, QrCode.Ecc.MEDIUM)` directly; use whichever the vendored source provides. The wrapper's contract — `(text) => string` SVG — is what matters.)

- [ ] **Step 3: Test `tests/unit/qr.test.ts`:**

```typescript
import { describe, it, expect } from 'vitest'
import { qrSvg } from '@/lib/qr'

describe('qrSvg', () => {
  it('produces a self-contained svg with a path', () => {
    const svg = qrSvg('https://archiv.stamm-greif.de/api/kiosk/download?d=abc.def')
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('viewBox="0 0')
    expect(svg).toContain('<path')
    expect(svg).not.toContain('http://www.w3.org/1999/xlink') // no external refs
  })

  it('is deterministic for the same input', () => {
    const a = qrSvg('same')
    const b = qrSvg('same')
    expect(a).toBe(b)
  })

  it('handles a long URL and does not throw on empty', () => {
    expect(() => qrSvg('x'.repeat(300))).not.toThrow()
    expect(() => qrSvg('')).not.toThrow()
  })
})
```

- [ ] **Step 4: Verify** — unit green; `pnpm exec tsc --noEmit`; `pnpm lint` (with the vendored-file disable in place) clean. **Commit** — `feat: vendored pure-TS QR encoder + inline-SVG wrapper (no new dependency)`

---

### Task 4: Kiosk endpoints — mint/revoke + signed download with consent re-check

**Files:**
- Create: `src/app/api/kiosk/session/route.ts` (POST mint, DELETE revoke)
- Create: `src/app/api/kiosk/download/route.ts` (GET signed download)
- Create: `src/lib/kiosk-session.ts` (shared: load+validate a session; mint helper)
- Test: `tests/int/kiosk.int.test.ts`

**Interfaces produced:** `loadValidSession(payload, sid): Promise<Session | null>` (null if missing/revoked/expired); `mintKioskLink(...)`. The download route is the safety-critical one.

- [ ] **Step 1: Shared session helper `src/lib/kiosk-session.ts`:**

```typescript
import type { Payload, PayloadRequest } from 'payload'

// Loads a KioskSession and returns it only if it is live (exists, not revoked, not past
// expiresAt). expiresAt on the row is authoritative; the token's own `exp` is only a stateless
// fast-path already checked by verifyKioskToken. overrideAccess:true because kiosk requests have
// no user; the row carries no photo data, only link lifecycle.
export async function loadValidSession(
  payload: Payload,
  sid: number,
  req?: PayloadRequest,
): Promise<{ id: number; expiresAt: string } | null> {
  const row = await payload
    .findByID({ collection: 'kiosk-sessions', id: sid, overrideAccess: true, disableErrors: true, depth: 0, req })
    .catch(() => null)
  if (!row) return null
  if (row.revokedAt) return null
  if (!row.expiresAt || new Date(row.expiresAt).getTime() <= Date.now()) return null
  return { id: Number(row.id), expiresAt: row.expiresAt as string }
}

// Max TTL the mint endpoint will grant. Same blank-string guard faces.ts uses for its numeric env.
export function kioskTtlHours(): number {
  const raw = process.env.KIOSK_LINK_TTL_HOURS?.trim()
  if (!raw) return 12
  const v = Number(raw)
  return Number.isFinite(v) && v > 0 ? v : 12
}
```

- [ ] **Step 2: Mint/revoke route `src/app/api/kiosk/session/route.ts`:**

```typescript
import { getPayload } from 'payload'
import config from '@payload-config'
import { getUser } from '@/lib/get-user'
import { signKioskToken } from '@/lib/kiosk-token'
import { kioskTtlHours } from '@/lib/kiosk-session'

export const dynamic = 'force-dynamic'

function baseUrl(req: Request): string {
  return process.env.KIOSK_PUBLIC_URL?.trim() || new URL(req.url).origin
}

// POST /api/kiosk/session — mint a link. Kurator/admin only. Body: { label?, hours? }.
export async function POST(req: Request): Promise<Response> {
  const user = await getUser()
  if (!user || (user.role !== 'admin' && user.role !== 'kurator')) {
    return Response.json({ error: 'Nicht berechtigt' }, { status: 403 })
  }
  const body = (await req.json().catch(() => ({}))) as { label?: string; hours?: number }
  const maxH = kioskTtlHours()
  const hours = Math.min(Math.max(Number(body.hours) || maxH, 1), maxH)
  const expiresAt = new Date(Date.now() + hours * 3600_000)
  const payload = await getPayload({ config })
  const session = await payload.create({
    collection: 'kiosk-sessions',
    data: { label: body.label ?? '', expiresAt: expiresAt.toISOString(), createdBy: user.id },
    overrideAccess: true,
  })
  const token = signKioskToken({ sid: Number(session.id), exp: expiresAt.getTime() })
  const url = `${baseUrl(req)}/kiosk?k=${encodeURIComponent(token)}`
  return Response.json({ url, expiresAt: expiresAt.toISOString(), sid: session.id })
}

// DELETE /api/kiosk/session — revoke. Body: { sid }. Kurator/admin only.
export async function DELETE(req: Request): Promise<Response> {
  const user = await getUser()
  if (!user || (user.role !== 'admin' && user.role !== 'kurator')) {
    return Response.json({ error: 'Nicht berechtigt' }, { status: 403 })
  }
  const { sid } = (await req.json().catch(() => ({}))) as { sid?: number }
  if (typeof sid !== 'number') return Response.json({ error: 'sid fehlt' }, { status: 400 })
  const payload = await getPayload({ config })
  await payload.update({
    collection: 'kiosk-sessions',
    id: sid,
    data: { revokedAt: new Date().toISOString() },
    overrideAccess: true,
  })
  return Response.json({ ok: true })
}
```

- [ ] **Step 3: Download route `src/app/api/kiosk/download/route.ts`:**

```typescript
import path from 'path'
import { promises as fs } from 'fs'
import { getPayload } from 'payload'
import config from '@payload-config'
import { verifyKioskToken } from '@/lib/kiosk-token'
import { kioskPhotoWhere } from '@/lib/kiosk-query'
import { loadValidSession } from '@/lib/kiosk-session'

export const dynamic = 'force-dynamic'

// GET /api/kiosk/download?d=<token>. No user auth — authority is the signed token PLUS a live
// consent re-check. Order (spec §4.5): verify signature+exp → session live? → kioskPhotoWhere()
// consent → stream original bytes. The consent re-check is what makes revoking consent kill an
// in-flight QR link: a photo hidden/binned/unmarked since the QR was rendered yields nothing here.
export async function GET(req: Request): Promise<Response> {
  const token = new URL(req.url).searchParams.get('d') ?? ''
  const payloadTok = verifyKioskToken(token, 'download')
  if (!payloadTok || !('pid' in payloadTok)) return new Response('Not found', { status: 404 })

  const payload = await getPayload({ config })
  const session = await loadValidSession(payload, payloadTok.sid)
  if (!session) return new Response('Not found', { status: 404 })

  // THE consent re-check. overrideAccess:true is safe only because kioskPhotoWhere() reimposes the
  // full consent filter and we AND it with this photo's id.
  const found = await payload.find({
    collection: 'photos',
    where: { and: [{ id: { equals: payloadTok.pid } }, kioskPhotoWhere()] },
    overrideAccess: true,
    limit: 1,
    depth: 0,
  })
  const photo = found.docs[0] as
    | { filename?: string; mimeType?: string; sizes?: { web?: { filename?: string } } }
    | undefined
  if (!photo) return new Response('Not found', { status: 404 })

  const dir = path.resolve(process.cwd(), 'photos')
  const name = photo.filename ?? photo.sizes?.web?.filename
  if (!name) return new Response('Not found', { status: 404 })
  let bytes: Buffer
  try {
    bytes = await fs.readFile(path.join(dir, name))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      payload.logger.info({ msg: 'kiosk-download-file-missing', photoId: payloadTok.pid, file: name })
      return new Response('Not found', { status: 404 })
    }
    throw err
  }
  return new Response(bytes as unknown as BodyInit, {
    headers: {
      'Content-Type': photo.mimeType ?? 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${name.replace(/[^\w.\-]/g, '_')}"`,
      'Cache-Control': 'no-store',
    },
  })
}
```

- [ ] **Step 4: Int test `tests/int/kiosk.int.test.ts`** — the safety property (spec §11). Follow `tests/int/invites.int.test.ts`'s header for the app-on-test-DB setup. Cover, using the **Local API** to create photos with each state and a valid token minted via `signKioskToken`:

```typescript
// Integration: the kiosk safety property (spec §3). A photo reaches the kiosk download ONLY if
// kioskFreigegeben AND published AND not-hidden-person AND not-binned — a VALID signature is never
// enough. Same app-on-test-DB setup as invites.int.test.ts (see its header).
import { describe, it, expect, beforeAll } from 'vitest'
import { getPayload, type Payload } from 'payload'
import config from '@payload-config'
import { signKioskToken } from '@/lib/kiosk-token'
import { kioskPhotoWhere } from '@/lib/kiosk-query'

let payload: Payload
let sid: number
const validExp = Date.now() + 3600_000

async function makePhoto(over: Record<string, unknown>): Promise<number> {
  // minimal upload via Local API with a real fixture (tests/fixtures/dia.jpg), then patch state
  const doc = await payload.create({
    collection: 'photos',
    data: { datePrecision: 'year', dateValue: '1990', ...over },
    filePath: 'tests/fixtures/dia.jpg',
    overrideAccess: true,
  })
  return Number(doc.id)
}

beforeAll(async () => {
  payload = await getPayload({ config: await config })
  const s = await payload.create({
    collection: 'kiosk-sessions',
    data: { label: 'test', expiresAt: new Date(validExp).toISOString() },
    overrideAccess: true,
  })
  sid = Number(s.id)
})

async function inKioskSet(pid: number): Promise<boolean> {
  const r = await payload.find({
    collection: 'photos',
    where: { and: [{ id: { equals: pid } }, kioskPhotoWhere()] },
    overrideAccess: true, limit: 1, depth: 0,
  })
  return r.totalDocs === 1
}
async function download(pid: number): Promise<number> {
  const d = signKioskToken({ sid, pid, exp: validExp })
  const res = await fetch(`http://localhost:3000/api/kiosk/download?d=${encodeURIComponent(d)}`)
  return res.status
}

describe('kiosk safety property', () => {
  it('serves a properly marked, published, not-hidden, not-binned photo', async () => {
    const pid = await makePhoto({ _status: 'published', kioskFreigegeben: true })
    expect(await inKioskSet(pid)).toBe(true)
    expect(await download(pid)).toBe(200)
  })
  it('never serves an UNMARKED published photo', async () => {
    const pid = await makePhoto({ _status: 'published', kioskFreigegeben: false })
    expect(await inKioskSet(pid)).toBe(false)
    expect(await download(pid)).toBe(404)
  })
  it('never serves a HIDDEN-PERSON photo even if marked (valid signature)', async () => {
    const person = await payload.create({ collection: 'people', data: { name: 'Verborgen', hidden: true }, overrideAccess: true })
    const pid = await makePhoto({ _status: 'published', kioskFreigegeben: true, people: [person.id] })
    expect(await inKioskSet(pid)).toBe(false)   // hasHiddenPerson recomputed on write
    expect(await download(pid)).toBe(404)
  })
  it('never serves a DRAFT marked photo', async () => {
    const pid = await makePhoto({ _status: 'draft', kioskFreigegeben: true })
    expect(await download(pid)).toBe(404)
  })
  it('never serves a BINNED marked photo', async () => {
    const pid = await makePhoto({ _status: 'published', kioskFreigegeben: true, deletedAt: new Date().toISOString() })
    expect(await download(pid)).toBe(404)
  })
  it('rejects a valid token once the session is revoked', async () => {
    const pid = await makePhoto({ _status: 'published', kioskFreigegeben: true })
    const s = await payload.create({ collection: 'kiosk-sessions', data: { label: 'rev', expiresAt: new Date(validExp).toISOString() }, overrideAccess: true })
    await payload.update({ collection: 'kiosk-sessions', id: s.id, data: { revokedAt: new Date().toISOString() }, overrideAccess: true })
    const d = signKioskToken({ sid: Number(s.id), pid, exp: validExp })
    const res = await fetch(`http://localhost:3000/api/kiosk/download?d=${encodeURIComponent(d)}`)
    expect(res.status).toBe(404)
  })
  it('rejects an expired token', async () => {
    const pid = await makePhoto({ _status: 'published', kioskFreigegeben: true })
    const d = signKioskToken({ sid, pid, exp: Date.now() - 1 })
    const res = await fetch(`http://localhost:3000/api/kiosk/download?d=${encodeURIComponent(d)}`)
    expect(res.status).toBe(404)
  })
})
```

(Confirm the Local API `create` with `filePath` matches the pattern used in `tests/int/duplicates.int.test.ts`/`heic.int.test.ts`; reuse whichever upload helper those files already have rather than re-deriving it.)

- [ ] **Step 5: Run int suite** (app on test DB per `invites.int.test.ts` header). All green. `tsc`+`lint`. **Commit** — `feat: kiosk mint/revoke + signed download endpoint with per-request consent re-check`

---

### Task 5: Kiosk slideshow page `/kiosk`

**Files:**
- Create: `src/app/(kiosk)/layout.tsx` (minimal fullscreen, noindex)
- Create: `src/app/(kiosk)/kiosk/page.tsx` (server component)
- Create: `src/app/(kiosk)/kiosk/Slideshow.tsx` (`'use client'`)
- Modify: `src/messages/de.ts` (`kiosk` block)

**Interfaces consumed:** `verifyKioskToken`, `kioskPhotoWhere`, `loadValidSession`, `signKioskToken` (per-photo download tokens), `qrSvg`.

- [ ] **Step 1: de strings** — add a `kiosk` block to `de.ts`:

```typescript
  kiosk: {
    invalid: 'Dieser Kiosk-Link ist ungültig oder abgelaufen.',
    empty: 'Zurzeit sind keine Fotos für den Kiosk freigegeben.',
    scanHint: 'Zum Herunterladen scannen',
  },
```

- [ ] **Step 2: Minimal layout `src/app/(kiosk)/layout.tsx`** — its own `<html>`/`<body>`, black background, no nav, `metadata.robots = { index:false, follow:false }`, `export const dynamic = 'force-dynamic'`. Do **not** call `getUser()` here (the kiosk has no session). Import the theme CSS only if needed; the beamer wants a plain black canvas.

- [ ] **Step 3: Server page `src/app/(kiosk)/kiosk/page.tsx`:**

```typescript
import { getPayload } from 'payload'
import config from '@payload-config'
import { verifyKioskToken, signKioskToken } from '@/lib/kiosk-token'
import { kioskPhotoWhere } from '@/lib/kiosk-query'
import { loadValidSession } from '@/lib/kiosk-session'
import { qrSvg } from '@/lib/qr'
import { de } from '@/messages/de'
import { Slideshow } from './Slideshow'
import type { Photo } from '@/payload-types'

export const dynamic = 'force-dynamic'

export default async function KioskPage({
  searchParams,
}: {
  searchParams: Promise<{ k?: string; interval?: string }>
}) {
  const { k = '', interval } = await searchParams
  const tok = verifyKioskToken(k, 'session')
  if (!tok) return <KioskMessage text={de.kiosk.invalid} />

  const payload = await getPayload({ config })
  const session = await loadValidSession(payload, tok.sid)
  if (!session) return <KioskMessage text={de.kiosk.invalid} />

  // overrideAccess:true is REQUIRED (no user) and SAFE only because kioskPhotoWhere() reimposes
  // the full consent filter — this is the one deliberate public overrideAccess in the app.
  const photos = await payload.find({
    collection: 'photos',
    where: kioskPhotoWhere(),
    overrideAccess: true,
    sort: '-dateSortKey',
    limit: 500,
    depth: 0,
  })
  if (photos.totalDocs === 0) return <KioskMessage text={de.kiosk.empty} />

  const expMs = new Date(session.expiresAt).getTime()
  const slides = (photos.docs as Photo[]).map((p) => {
    const dl = signKioskToken({ sid: session.id, pid: Number(p.id), exp: expMs })
    return {
      id: p.id,
      src: p.sizes?.web?.url ?? p.url ?? '',
      caption: p.caption ?? '',
      qr: qrSvg(`/api/kiosk/download?d=${encodeURIComponent(dl)}`),
    }
  })
  const seconds = Math.min(Math.max(Number(interval) || 8, 3), 60)
  return <Slideshow slides={slides} intervalMs={seconds * 1000} scanHint={de.kiosk.scanHint} />
}

function KioskMessage({ text }: { text: string }) {
  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', color: '#eee', background: '#000' }}>
      <p>{text}</p>
    </div>
  )
}
```

> The QR encodes a **root-relative** `/api/kiosk/download?...`; the phone scans it against the kiosk's own origin. If the beamer is reached over a bare Tailscale IP where a relative URL is fine, this suffices; if an absolute URL is needed, prefix with `KIOSK_PUBLIC_URL` (same env the mint route uses). Decide during implementation and keep both routes consistent.

- [ ] **Step 4: Client `Slideshow.tsx`** (`'use client'`) — props `{ slides, intervalMs, scanHint }`. State: current index, paused. `useEffect` interval advancing index (skip while paused). Keydown handler (←/→ step, space toggle pause, `f` `requestFullscreen`). Three tap zones (absolutely-positioned overlay divs: left=prev, right=next, centre=toggle). Render current slide `<img>` cover-fit on black, caption bottom-left, `<div dangerouslySetInnerHTML={{__html: slide.qr}}>` bottom-right (fixed ~140px) with `scanHint` under it. Crossfade via CSS opacity is optional; no transition library.

- [ ] **Step 5: Verify** — `tsc`+`lint` clean; unit+int still green. Manual smoke against `pnpm dev`: mint a link (Task 4 route), open `/kiosk?k=…`, confirm advance + QR renders + scanning downloads. **Commit** — `feat: /kiosk fullscreen slideshow (signed-link scoped, per-image QR, keyboard/tap)`

---

### Task 6: Kiosk admin page `/kiosk-admin`

**Files:**
- Create: `src/app/(frontend)/kiosk-admin/page.tsx` (server component, kurator/admin gate)
- Create: `src/app/(frontend)/kiosk-admin/KioskAdmin.tsx` (`'use client'` mint/revoke UI)
- Modify: `src/messages/de.ts` (`kioskAdmin` block)
- Modify: `src/app/(frontend)/layout.tsx` (nav link for kurator/admin)

- [ ] **Step 1: de strings** `kioskAdmin` block: title, hint, `label` field, `hours` field, `mint`, `open`, `copy`, `revoke`, `active`, `expiresAt`, `revoked`, empty-state, error.

- [ ] **Step 2: Server page** — `getUser()`; `redirect('/anmelden')` if no user; render „nicht berechtigt" if not kurator/admin (mirror `/gesichter`'s gate). Fetch active sessions (`payload.find({ collection:'kiosk-sessions', where:{ revokedAt:{ exists:false } }, sort:'-createdAt', overrideAccess:false, user })`) and pass to the client component.

- [ ] **Step 3: Client `KioskAdmin.tsx`** — a form (label + hours picker, default `KIOSK_LINK_TTL_HOURS`) POSTing `/api/kiosk/session`; on success show the returned `url` (read-only input + copy button + "open on beamer" link + the QR of the kiosk URL itself, optional). A list of active sessions each with a „Widerrufen" button DELETEing `/api/kiosk/session`. Use `de.kioskAdmin.*`; surface errors via the existing `formatServerError` helper (`src/lib/server-error.ts`).

- [ ] **Step 4: Nav** — in `(frontend)/layout.tsx`, add `{user && (user.role==='admin'||user.role==='kurator') && <Link href="/kiosk-admin">{de.nav.kiosk}</Link>}` next to the `/gesichter` link; add `de.nav.kiosk = 'Kiosk'`.

- [ ] **Step 5: Verify** — `tsc`+`lint`; smoke mint+revoke against `pnpm dev`. **Commit** — `feat: /kiosk-admin page to mint and revoke signed kiosk links`

---

### Task 7: Timeline / series scrub `/zeitleiste`

**Files:**
- Create: `src/app/(frontend)/zeitleiste/page.tsx` (server component)
- Create: `src/app/(frontend)/zeitleiste/YearBand.tsx` (`'use client'` scrubber)
- Modify: `src/messages/de.ts` (`zeitleiste` block)
- Modify: `src/app/(frontend)/layout.tsx` (nav link, members)

- [ ] **Step 1: de strings** `zeitleiste` block: title, chooseSeries, emptyYear, noSeries, `jahr`.

- [ ] **Step 2: Server page** — `getUser()`; `redirect('/anmelden')` if none. `searchParams: { serie?, e? }`.
  - No `serie`: `payload.find({ collection:'event-series', pagination:false, overrideAccess:false, user })`; render a list linking to `?serie=<id>`.
  - With `serie`: load series (`findByID`, `overrideAccess:false, user`, `.catch(()=>null)`→`notFound()`); load its events (`where:{ series:{ equals:serie } }, sort:'dateSortKey', overrideAccess:false, user`). Compute each event's year via `parseFuzzyDate`. Selected event = `?e=` or the first. Load that event's photos (`where:{ event:{ equals:selected } }, sort:'-dateSortKey', limit:200, overrideAccess:false, user`) — **consent enforced by `canReadPhoto` automatically**, no kiosk logic. Render `<YearBand>` (events→year chips, selected highlighted) + `<PhotoGrid photos={…}>`. Empty photo set → `de.zeitleiste.emptyYear`.

  Reuse the exact data shapes from `src/app/(frontend)/ereignisse/[id]/page.tsx` (same `payload.find` photo query, same `parseFuzzyDate`, same `PhotoGrid`).

- [ ] **Step 3: Client `YearBand.tsx`** — props `{ items: {eventId, year, name}[], selected, serie }`. Horizontal scrollable strip of year chips (`<Link href={\`/zeitleiste?serie=${serie}&e=${eventId}\`}>`). Keyboard ←/→ moves selection (push the neighbouring event's URL via `next/navigation`'s `useRouter`). Purely a navigation aid; the page stays server-rendered and shareable by URL.

- [ ] **Step 4: Nav** — add `{user && <Link href="/zeitleiste">{de.nav.zeitleiste}</Link>}` (all members) and `de.nav.zeitleiste = 'Zeitleiste'`.

- [ ] **Step 5: Verify** — `tsc`+`lint`; unit+int green; smoke a series with 2+ events against `pnpm dev`. **Commit** — `feat: /zeitleiste series scrub — year band + consent-filtered event photos (members)`

---

### Task 8: Rollout — env, ops doc, full gate, PR

**Files:**
- Modify: `.env.example`, `docker-compose.yml`
- Modify: `docs/betrieb.md`
- Modify: `README.md` (feature list line, if it enumerates features)

- [ ] **Step 1: Env.** Add to `.env.example` under a „Kiosk (P2.4)" comment:
```sh
# Kiosk (P2.4). Max lifetime an admin/kurator can grant a signed kiosk link (hours). Default 12.
KIOSK_LINK_TTL_HOURS=12
# Optional: absolute base URL the QR/kiosk links should use if the request origin isn't right
# (e.g. behind a proxy). Defaults to the request origin when unset.
KIOSK_PUBLIC_URL=
```
Pass both through in `docker-compose.yml`'s `app` env block (`KIOSK_LINK_TTL_HOURS: ${KIOSK_LINK_TTL_HOURS:-12}`, `KIOSK_PUBLIC_URL: ${KIOSK_PUBLIC_URL:-}`), same pattern as the `FACE_*` vars.

- [ ] **Step 2: betrieb.md** — new German section „Kiosk & Zeitleiste" (before „Monitoring"):
  - *Kiosk aufsetzen:* als Kurator/Admin `/kiosk-admin` öffnen, Link mit Ablaufzeit erzeugen, auf dem Beamer/Tablet öffnen (`f` für Vollbild). Kein Login auf dem Gerät.
  - *Was angezeigt wird + Konsens-Regeln:* nur Fotos, die (a) ein Kurator ausdrücklich „Für Kiosk freigegeben" hat **und** (b) veröffentlicht, nicht verborgen und nicht im Papierkorb sind. **Der Kiosk ist ohne Anmeldung öffentlich sichtbar — niemals Fotos von Minderjährigen oder mitglieder-interne Fotos freigeben.** Wird eine Einwilligung widerrufen (Person „verbergen"), verschwindet das Foto sofort aus Slideshow und QR-Downloads, auch aus bereits gezeigten QR-Codes.
  - *Link widerrufen:* in `/kiosk-admin` „Widerrufen" — der Link ist sofort tot, ohne Neustart und ohne Auswirkung auf Mitglieder-Logins. Links laufen ohnehin nach `KIOSK_LINK_TTL_HOURS` (Standard 12 h) ab.
  - *Nichts wird indexiert:* der Kiosk trägt `robots: noindex` wie der Rest der App.
  - *Zeitleiste:* `/zeitleiste`, nur für angemeldete Mitglieder — eine Ereignisreihe wählen und Jahr für Jahr durch die Fotos gehen. Kein öffentlicher Zugriff, dieselben Konsens-Regeln wie im übrigen Archiv.

- [ ] **Step 3: Full local gate.** `pnpm lint`; `pnpm exec tsc --noEmit`; `pnpm test:unit`; int suite (app on test DB — start `pnpm dev` against `archiv_test` per `invites.int.test.ts` header, then `pnpm test:int`); `pnpm exec playwright test --workers=1`. `docker compose config >/dev/null`. `pnpm payload migrate:create ci_drift_check --skip-empty` → no new file. `shellcheck scripts/*.sh` (unchanged, but the hygiene job runs it).

- [ ] **Step 4: PR.** Push the branch, open PR (base `main`) summarising the spec + the safety property + the two owner decisions. CI must go green (`test`, `e2e`, `docker`, `hygiene`, drift). Address CodeRabbit; resolve all threads.

- [ ] **Step 5: USER GATE** — ask before merging. After merge: on `main`, follow `betrieb.md`'s migrate discipline on the live stack (`docker compose build migrate` → `docker compose run --rm migrate` → `docker compose up -d --build`), then smoke: mint a link as admin, open `/kiosk`, scan one QR, confirm the download; open `/zeitleiste`, step a year. Do **not** touch the running stack before the user gate.

- [ ] **Step 6: Commit** — `docs: kiosk/zeitleiste env + betrieb.md section (setup, consent rules, revoke)` and finalise the PR.

---

## Self-review (done at write time)

- **Spec coverage:** every spec section maps to a task — schema §9 → T1; token/filter §3–4.2 → T2; QR §6 → T3; endpoints/download §4.4–4.5 → T4; slideshow §5 → T5; admin mint/revoke §4.3 → T6; timeline §7 → T7; env/ops/rollout §10 → T8. Consent §8 is enforced across T2 (`kioskPhotoWhere`), T4 (download re-check), T5 (slideshow fetch), T7 (`overrideAccess:false`).
- **The safety property is pinned by tests, not prose:** T2 unit (token can't be the gate — expired/tampered/wrong-secret/kind-mismatch all reject) + T4 int (unmarked/hidden/draft/binned/revoked/expired all 404 with a *valid* signature; positive control serves). `kioskPhotoWhere()` is the single filter both surfaces import; the plan forbids inlining it.
- **No placeholders in load-bearing code:** token lib, consent filter, both endpoints, the server page, and the int test are complete. The one deliberate exception is the **vendored QR encoder (T3)** — its ~600 lines are vendored from a named MIT source rather than pasted, with the app-specific wrapper + test given in full; flagged in-task and here. The `Slideshow.tsx`/`YearBand.tsx`/admin client components are specified by behaviour + props rather than full JSX, matching how the telemetry plan specifies `UploadForm.tsx` edits by behaviour — they carry no security logic (all consent decisions are server-side), so this is acceptable altitude.
- **Type consistency:** `signKioskToken`/`verifyKioskToken`/`KioskTokenPayload` names match across T2/T4/T5; `kioskPhotoWhere(): Where` used identically in T4/T5; `loadValidSession`/`kioskTtlHours` shared T4/T5/T6; session fields (`label/expiresAt/revokedAt/createdBy`) consistent T1/T4/T6.
- **Migration discipline:** one `migrate:create` (T1), drift-checked (T1 S6, T8 S3), applied on deploy per betrieb.md (T8 S5). No hand-edited SQL needed (no cascades).
- **No VPS blocker / no new dependency:** QR vendored; no new container/service; ships in the existing image. Verified against `package.json` (no QR dep to add) and the existing upload-serving path (`process.cwd()/photos`).
- **Consent-critical contradiction check:** searched for any path that reads a kiosk photo with `overrideAccess:true` without `kioskPhotoWhere()` — none in the plan; the timeline never uses `overrideAccess:true` at all. `hasHiddenPerson` is recomputed on write by the existing `Photos` beforeChange hook, so a photo whose person is hidden after marking flips `hasHiddenPerson=true` and is excluded by the filter without any kiosk-specific code — the T4 hidden-person test asserts exactly this.

## Open questions for the owner

1. **Absolute vs relative QR URL.** The plan defaults the QR to a root-relative `/api/kiosk/download?…` (works when the phone scans against the kiosk's own origin) with `KIOSK_PUBLIC_URL` as the override. On the live Tailscale/Caddy setup, is the beamer reached at `https://archiv.stamm-greif.de` (so relative is fine) or at a bare Tailscale hostname/IP a guest phone can't resolve? If the latter, `KIOSK_PUBLIC_URL` must be set to a guest-reachable URL — otherwise scanned QRs won't resolve on visitors' phones. This is a deployment fact, not a code decision, so it is left to confirm rather than guessed.
