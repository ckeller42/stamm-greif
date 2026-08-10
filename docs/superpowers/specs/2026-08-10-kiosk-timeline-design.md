# Kiosk Mode + Timeline/Series Scrub — Design

**Date:** 2026-08-10
**Sub-project:** P2.4 (Phase 2, spec `2026-08-03-scout-archive-design.md` §5: "Kiosk mode" + "Timeline / series scrub")
**Status:** Approved in principle — owner decisions on auth and curation are fixed (see §2); implementation-detail recommendations are marked **[Empfehlung]** below.

## 1. Purpose

Two Fest-facing surfaces for the 2027 Jubiläum, both drawing on the existing archive:

1. **Kiosk mode** — a fullscreen slideshow for a tablet/beamer in the hall. Runs **without a login on the device**, from a time-limited signed link an admin mints. Each photo carries a QR code that a guest scans to download that photo. This is the only surface in the whole system reachable without authentication, so it is designed under the hardest consent constraint in the project.
2. **Timeline / series scrub** — an in-app, members-only page to step through a recurring `EventSeries` (e.g. Sommerlager 1985 → 2025) year by year, showing each event's photos. It reuses the event page's data shape and consent model; it is **not** public and is unrelated to the kiosk beyond sharing the archive.

The organising constraint for both: **the consent model that already governs `Photos` (`canReadPhoto` in `src/collections/Photos.ts`) is never bypassed, only ever further restricted.** A photo of a hidden person, a draft, or a binned photo must never surface on either — and, critically, must never reach the public beamer even by accident.

## 2. Owner decisions (fixed)

1. **Kiosk auth = signed kiosk link + signed downloads.** An admin generates a time-limited signed kiosk URL (HMAC keyed on `PAYLOAD_SECRET`, expiry embedded, verified server-side), reachable **without login**. The slideshow runs from that link. Each photo's QR points to a **signed, expiring direct-download URL**. No standing login lives on the device. The link is **revocable**. Nothing on this surface ever becomes permanently public or search-indexed.
2. **Kiosk content = curated allowlist.** A kurator/admin explicitly marks a photo kiosk-safe via a new boolean `kioskFreigegeben` on `Photos` (default `false`, kurator/admin-writable). **Only** marked photos are eligible for the kiosk. The allowlist is an **additional restriction, never a bypass**: a marked photo must still pass every existing consent gate — the kiosk query ANDs `kioskFreigegeben` with `published` + `not hidden-person` + `not binned`. Minors'/member-only photos must never reach the public beamer; the curated flag is the **human gate** and kurators must not mark member-only/minor photos (documented in `de.ts` field help + `betrieb.md`).

## 3. Threat model & the one safety property

The kiosk is unauthenticated. Anyone with the signed link (or a QR photo from it) is, from the app's view, `req.user == null`. Under the existing `canReadPhoto`, `!user` returns `false` — i.e. Payload's own access control would show them **nothing**. The kiosk therefore cannot lean on collection access; it must run its queries with `overrideAccess: true` and **re-impose the consent filter by hand**. That hand-written filter is the single most safety-critical artifact in this sub-project.

**Safety property (the thing the tests exist to prove):** for every kiosk surface — slideshow data fetch *and* per-photo download — a photo is served **only if** all of:

```
kioskFreigegeben == true
AND _status == 'published'
AND hasHiddenPerson != true
AND deletedAt does not exist
```

hold at request time. Consequences that fall out of "at request time":

- An **unmarked** photo (`kioskFreigegeben=false`) never appears, even though it is published and visible in the authed app.
- A **hidden-person** photo never appears, even if a kurator mistakenly marked it `kioskFreigegeben=true` — the AND makes the flag powerless to override consent.
- A **draft** or **binned** marked photo never appears.
- **Revoking consent kills in-flight QR links:** the download endpoint re-runs the filter on every request, so a photo whose person is hidden *after* the beamer rendered its QR returns 404 when a guest later scans it.

To make drift structurally impossible, the filter lives in exactly one place — `kioskPhotoWhere()` in `src/lib/kiosk-query.ts` — imported by both the slideshow fetch and the download endpoint. Neither surface constructs the `where` inline. [Empfehlung]

## 4. Kiosk — signed-link scheme

### 4.1 Token shape

Two token kinds, same primitive (`src/lib/kiosk-token.ts`):

- **Session token** (the kiosk link): signs `{ sid, exp }` where `sid` is a `KioskSession` id and `exp` is a unix-ms expiry. Encoded `base64url(json) + '.' + base64url(hmac)`. Carried as `/kiosk?k=<token>`.
- **Download token** (per photo, in each QR): signs `{ sid, pid, exp }` — session id, photo id, expiry. Carried as `/api/kiosk/download?d=<token>`.

Both are HMAC-SHA256. The signing key is **derived** from `PAYLOAD_SECRET`, not the secret itself: `key = HMAC-SHA256(PAYLOAD_SECRET, 'kiosk-v1')`. Derivation keeps kiosk signatures from being interchangeable with any other use of the secret and gives a version handle (`kiosk-v1`) for a future rotation without touching `PAYLOAD_SECRET` (which would log every member out). [Empfehlung]

### 4.2 Verification

`verifyKioskToken(token, kind)` (pure, unit-tested):

1. Split on `.`; base64url-decode both halves.
2. Recompute the HMAC over the payload bytes; compare with `crypto.timingSafeEqual` (constant-time; guards against signature-forgery timing oracles). Length-mismatch → reject before compare.
3. `JSON.parse` the payload; check `kind` matches the field set present (session vs download) and `exp > Date.now()`.
4. Return the typed payload or `null`. **Never throws** — any malformed input is a `null`, mapped to 404 by callers.

Token verification is stateless (no DB) and cheap; it is the fast rejection path. Everything that needs the DB (revocation, consent) happens *after* a token verifies.

### 4.3 Revocation — `KioskSession` record [Empfehlung]

A new admin-only collection `kiosk-sessions` (slug `kiosk-sessions`) is the revocation and audit story:

| Field | Type | Notes |
|---|---|---|
| `label` | text | Free label, e.g. „Jubiläum Beamer Halle" — what this link is for |
| `expiresAt` | date, required | Authoritative expiry (source of truth; the token's `exp` is a fast-path copy) |
| `revokedAt` | date | Set to revoke immediately; absent = active |
| `createdBy` | relationship→users, readOnly | Server-set audit trail |

Access: `read/create/update/delete: isAdmin` (kurators mint via the page endpoint, which runs `overrideAccess:true`; direct collection CRUD stays admin-only — same posture as `Invites`). Every kiosk request, after the token verifies, loads the session and rejects if it is missing, `revokedAt` is set, or `expiresAt` has passed. So there are **two** expiry checks (token `exp` fast-path, then session `expiresAt` authoritative) and one revocation check, all server-side.

**Revoke = one field write** (`revokedAt = now`) — no secret rotation, no redeploy, no effect on member logins. Rejected alternative: rotating a standalone kiosk secret invalidates *all* links at once and has no per-link audit; kept only as the documented fallback if the collection is ever deemed overkill.

Why the token still embeds `exp` when the session row is authoritative: the common attack/junk case (expired or forged link) is rejected with zero DB load; only a *validly-signed, unexpired* token reaches the session lookup.

### 4.4 Endpoints (Next route handlers, not Payload collection endpoints)

Kiosk endpoints live under `src/app/api/kiosk/*` as Next route handlers, the same class as `/api/health` — a **static route that wins over Payload's `/api/[...slug]` catchall**, and, unlike a Payload collection endpoint, runs entirely outside Payload's auth so the unauthenticated device can reach it.

| Route | Method | Auth | Does |
|---|---|---|---|
| `/api/kiosk/session` | POST | kurator/admin (session cookie) | Mint: create `KioskSession`, return `{ url, expiresAt }`. Expiry from a picker, clamped to `KIOSK_LINK_TTL_HOURS` max. |
| `/api/kiosk/session` | DELETE | kurator/admin | Revoke: set `revokedAt` on `{ sid }`. |
| `/api/kiosk/download` | GET | signed download token | Verify token → load+check session → **`kioskPhotoWhere()` consent re-check** → stream bytes with `Content-Disposition: attachment`. |

The mint/revoke routes authenticate the operator via `getUser()` (same helper the pages use) and reject non-kurator/admin. The download route has **no** user auth — its authority is the signed token *plus* the live consent re-check.

### 4.5 Download endpoint — what it serves and re-checks

On `GET /api/kiosk/download?d=<token>`:

1. `verifyKioskToken(d, 'download')` → `{ sid, pid, exp }` or 404.
2. Load `KioskSession sid`; reject (404) if missing / revoked / expired.
3. `payload.find({ collection:'photos', where: { and: [ { id: { equals: pid } }, ...kioskPhotoWhere() ] }, overrideAccess:true, limit:1 })`. Empty → 404. **This is the consent re-check** — a photo hidden/binned/unmarked since the QR was rendered yields nothing.
4. Resolve the file on disk exactly as `src/jobs/detectFaces.ts` does (`path.resolve(process.cwd(),'photos', filename)` — Photos has no `staticDir` override). Stream the **original** file (the guest wants the real scan, not a 1600px web copy) with `Content-Type` from the stored mimetype and `Content-Disposition: attachment; filename="<friendly>.<ext>"`. Fall back to the `web` size only if the original file is missing on disk. [Empfehlung: original]
5. ENOENT → 404, logged `msg:'kiosk-download-file-missing'` (same soft-no-op posture as detectFaces' file read).

No range/streaming-resume support (Non-goal); a single `Response` with the file buffer is sufficient for photo-sized payloads on hall wifi.

## 5. Kiosk — the slideshow page

**Route:** `/kiosk` in its **own route group** `src/app/(kiosk)/` with a minimal root layout — `robots: { index:false, follow:false }`, black fullscreen background, **no header/nav** (the `(frontend)` layout's nav and `getUser()` chrome are exactly what a beamer must not show). The page is a **server component**:

1. Read `?k=<token>` (there is no session cookie to read). `verifyKioskToken(k,'session')` → `{ sid }` or render the graceful invalid/expired state (`de.kiosk.invalid`, no photos, no detail leaked).
2. Load + check the `KioskSession` (revoked/expired → same invalid state).
3. Fetch eligible photos: `payload.find({ collection:'photos', where: kioskPhotoWhere(), overrideAccess:true, sort:'-dateSortKey', limit: <cap> })`. **`overrideAccess:true` is required** (no user) and **safe only because `kioskPhotoWhere()` reconstructs the full consent filter** — this is the one place the codebase deliberately overrides access on a public surface, called out in a load-bearing comment.
4. Empty result → `de.kiosk.empty` (calm "nothing to show yet" panel, never an error).
5. Otherwise render a small **client** slideshow component seeded with the photo list + per-photo download token (minted server-side for each photo, `exp` = session `expiresAt`).

**Client slideshow** (`(kiosk)/kiosk/Slideshow.tsx`, `'use client'`):

- Auto-advance on an interval; interval configurable via `?interval=<seconds>` (default 8s, clamped 3–60). Ken-Burns/zoom is **out of scope** (Non-goal: transitions library) — a plain crossfade via CSS opacity is the ceiling.
- Controls: keyboard (←/→ step, space pause/resume, `f` fullscreen) and tap zones (left third = back, right third = forward, centre = pause). Fully operable from a touch beamer with no keyboard.
- Each slide shows the photo (`web` size) filling the screen, an optional caption + fuzzy-date label (reusing `parseFuzzyDate`), and a **QR** in a corner (inline SVG from `src/lib/qr.ts`) encoding the absolute `/api/kiosk/download?d=<token>` URL. A short caption „Zum Herunterladen scannen" (`de.kiosk.scanHint`).
- No network calls after load beyond image fetches (the photo list and tokens are baked into the initial server render) — the device never needs to re-auth.

## 6. Kiosk — QR generation [Empfehlung: vendored pure-TS, inline SVG]

**Assessment.** No QR dependency exists today. Options: (a) add the `qrcode` npm package — mature/MIT but pulls transitive deps (`pngjs`, `dijkstrajs`) we'd use none of, for SVG-string output; (b) vendor a single-file MIT pure-TS QR encoder (Nayuki's "QR Code generator", widely used, ~one file, no deps) into `src/lib/vendor/qr-codegen.ts` and wrap it. **Recommend (b):** zero new npm dependency, no supply-chain surface, fully offline (matches the self-hosted, no-external-calls ethos already stated for face detection), and unit-testable. The wrapper `src/lib/qr.ts` exposes `qrSvg(text: string): string` returning a self-contained `<svg>` (crisp `<path>`, `shape-rendering="crispEdges"`, no external refs) suitable to inline in the slideshow and safe under the app's CSP. Generation is **server-side** (the token is minted server-side anyway), so no QR library ships to the client.

## 7. Timeline / series scrub

**Route:** `/zeitleiste`, in the normal `(frontend)` group — **members-only**, `getUser()` + `redirect('/anmelden')` exactly like the event/person pages. This surface uses `overrideAccess:false` + `user`, so **consent is enforced automatically by `canReadPhoto`** — no hand-written filter, no `overrideAccess:true`. It is deliberately *not* the kiosk and shares no auth path with it.

- **`/zeitleiste`** (no series selected): list `event-series` (a small server fetch), each linking to `/zeitleiste?serie=<id>`. Simple index.
- **`/zeitleiste?serie=<id>`**: load the series + its events (`payload.find({ collection:'events', where:{ series:{ equals:id } }, sort:'dateSortKey', overrideAccess:false, user })`). Derive each event's year from its fuzzy date (`parseFuzzyDate`). Render a **horizontal year band** (the events as a scrollable strip of year chips) + the selected event's photos below, reusing the **event page's data shape** (`payload.find` photos `where:{ event:{ equals } }`, `overrideAccess:false`, `user`) and `PhotoGrid`.
- Which event is shown is a URL param (`?serie=<id>&e=<eventId>`), so it is server-rendered and shareable; the year band is a **small client component** only for the scrub interaction (keyboard ←/→ to move between years, updating the param) — house pattern: server-rendered with minimal client interactivity, mirroring how `/gesichter` and the event page are built.
- Empty/edge: a series with one event still renders (band of one); a series with no readable photos in a given year shows `de.zeitleiste.emptyYear`.

Because every fetch here is `overrideAccess:false` with the real `user`, a member sees exactly what they'd see anywhere else in the app (hidden-person photos already filtered by `canReadPhoto`; kurators see more, as everywhere). No new consent logic is introduced on this surface — that is the point of keeping it in the authed app.

## 8. Consent enforcement — surface by surface (summary)

| Surface | User? | Access mode | How consent holds |
|---|---|---|---|
| `/kiosk` slideshow fetch | none | `overrideAccess:true` | `kioskPhotoWhere()` ANDs `kioskFreigegeben` + published + not-hidden + not-binned |
| `/api/kiosk/download` | none | `overrideAccess:true` | Same `kioskPhotoWhere()`, **re-checked per request** → revoking consent kills live QR links |
| `/kiosk-admin` mint/revoke | kurator/admin | session cookie | Operator auth in the route; sessions collection admin-only |
| `/zeitleiste` (all fetches) | member+ | `overrideAccess:false` + `user` | `canReadPhoto` applies unchanged — no kiosk logic involved |

The kiosk allowlist (`kioskFreigegeben`) is **only ever an extra AND term**; it appears in no `OR`, and no code path reads a kiosk photo with `overrideAccess:true` *without* `kioskPhotoWhere()`. The two facts that make this safe are localised: the single filter helper (§3) and the download re-check (§4.5).

## 9. Schema & data

- **`Photos.kioskFreigegeben`**: `checkbox`, `defaultValue:false`, label „Für Kiosk freigegeben". Field access: `read` open (harmless to read; it's not sensitive), `create`/`update`: kurator/admin only (`isKuratorOrAdminField`, the existing field-access predicate). Admin help text states the consent rule (never mark minor/member-only photos). Because `Photos` has `versions.drafts:true`, the migration adds both `photos.kiosk_freigegeben` and `_photos_v.version_kiosk_freigegeben`.
- **`kiosk-sessions` collection** (§4.3): four fields, admin-only, its own tables via `migrate:create`.
- Migrations produced by `pnpm payload migrate:create` against the dev DB, committed under `src/migrations/`, verified by CI's existing **drift check** (`migrate:create ci_drift_check --skip-empty` must produce nothing). No hand-edited SQL is needed (no cascade/`ON DELETE` special-casing — `KioskSession` has no children; `kioskFreigegeben` is a plain column).

## 10. Environment & rollout

- **`KIOSK_LINK_TTL_HOURS`** (default `12`) — the maximum expiry the mint endpoint will grant; the picker cannot exceed it. 12h covers a full Fest day without leaving links valid for weeks. Wired in `.env.example` and passed through in `docker-compose.yml` like the `FACE_*` vars. Blank-string trap guarded exactly as `faces.ts`'s numeric parsers do (`raw?.trim()`, explicit blank check before `Number()`).
- **`betrieb.md`** gets a German „Kiosk & Zeitleiste" section: *Kiosk aufsetzen* (open `/kiosk-admin` as kurator/admin, mint a link, open it on the beamer), *Link widerrufen* (revoke button → dead instantly), *Was angezeigt wird und die Konsens-Regeln* (only `kioskFreigegeben` + published + not-hidden + not-binned; **kurators must not mark member-only/minor photos**; the beamer is public), *Zeitleiste-Nutzung* (members only, in-app). Notes the revoke story and that nothing becomes indexed.
- **No VPS blocker:** no new container, no new heavy/native dependency (QR is vendored pure-TS), no new service. Ships in the existing app image.
- **CI:** unchanged required checks (`test`, `e2e`, `docker`, `hygiene`) plus the drift check must stay green. Migration discipline per `betrieb.md` (rebuild `migrate` image, run before app restart).

## 11. Testing

- **Unit** (`src/lib/**`, run by `test:unit`):
  - `kiosk-token`: sign→verify round-trips; **expired** token → `null`; **tampered** payload or signature → `null`; **wrong-secret** signature → `null`; malformed/garbage input → `null` (never throws); session vs download `kind` mismatch → `null`.
  - `qr`: encodes a known string to a stable module count / non-empty `<svg>`; empty string handled.
- **Integration** (`test:int`, app on the test DB) — the **safety property (§3)** is the point:
  - A published **hidden-person** photo with `kioskFreigegeben=true` is **absent** from the `/kiosk` data fetch **and** its download token yields 404 (fabricated with a *valid* signature to prove the signature is not the gate — consent is).
  - An **unmarked** published photo (`kioskFreigegeben=false`) is absent from both.
  - A **draft** and a **binned** marked photo are each absent from both.
  - A **revoked** session → slideshow shows the invalid state, download → 404, even with a still-unexpired token.
  - An **expired** token → 404 / invalid state.
  - Positive control: a properly marked, published, not-hidden, not-binned photo **is** served and downloads its bytes.
- **E2E** (optional): mint a link as admin via `/kiosk-admin`, open `/kiosk?k=…`, assert the slideshow renders a slide and advances; `/zeitleiste` renders a series band and steps a year. Kept optional — the safety property is fully covered by int tests, which are the ones that matter.

## 12. Non-goals

Public gallery / open browsing; kiosk analytics or view tracking; video; a transitions/animation library (crossfade only); range/resumable downloads; QR for anything but the direct-download URL; multi-tenant kiosk themes. `Fotobuch`-Export and map view remain their own Phase-2 sub-projects.
