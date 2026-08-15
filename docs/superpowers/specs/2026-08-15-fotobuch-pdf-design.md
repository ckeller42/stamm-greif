# Fotobuch PDF-Export (in-process React-PDF) — Design

**Date:** 2026-08-15
**Sub-project:** P2.5 (Phase 2, spec `2026-08-03-scout-archive-design.md` §5: "Fotobuch export: pick Event, EventSeries, or Person → print-ready PDF (cover, story, captioned photos; person book includes group/event history)")
**Status:** DRAFT — awaiting owner sign-off. Three owner decisions are fixed and not re-opened here (§2). Everything marked **[Empfehlung]** is my recommendation and open to change.

## 1. Purpose

A kurator/admin picks an **Event**, an **EventSeries**, or a **Person** and gets a print-ready A4 **PDF** — cover, story/bio, chronological captioned photo grid; the person book additionally carries the person's Sippen/Meuten history and attended events, exactly as `personen/[id]` renders them. It is the third of the Fest-facing artifacts (after kiosk P2.4 and alongside the timeline), for producing physical books for the 2027 Jubiläum.

The PDF is a **durable file that leaves the system**. That single fact drives the whole design: it gets the **hardest consent bar in the project** on its output (§3), the same posture the unauthenticated kiosk gets — even though, unlike the kiosk, only a logged-in kurator ever triggers it.

## 2. Owner decisions (fixed)

1. **Engine = `@react-pdf/renderer`** — pure JS/React PDF rendering, **no headless browser, no Chromium, no new container**. This is the deliberate pivot away from the scout-archive spec's original "print-styled Next.js page → headless-Chromium PDF" line, for the same reason face detection pivoted off `onnxruntime-node` to WASM: **Alpine/musl fragility**. A headless-Chromium PDF path would drag a ~300 MB browser (or a separate container) into a hard-won `node:22-alpine` image that compiles sharp from source. `@react-pdf/renderer` needs none of it. §5 verifies — as the faces spec verified `onnxruntime-node` — that nothing in its tree is a native-glibc dependency that would break the Alpine image.
   - **Images in the PDF are fed as buffers, never URLs.** `@react-pdf/renderer`'s `<Image src={{ data: Buffer, format: 'jpg' }} />` takes raw bytes. The generator reads the on-disk `web` derivative (or the original) from `<cwd>/photos` exactly as `detectFaces.ts` / the kiosk image route already do, and transcodes it through `sharp` (already a dependency) to a bounded JPEG buffer. **No self-HTTP-fetch, no auth headache, no format-decode gap** (§6.3).
2. **Consent is HARD on the OUTPUT.** The book contains **only** photos that are `published` **AND** `hasHiddenPerson != true` **AND** `deletedAt` not set — the same AND-terms as `kioskPhotoWhere()` **minus the kiosk allowlist**. This holds **regardless of the generating user's role**: a kurator normally sees hidden-person photos in the app (`canReadPhoto` returns `true` for them), but the export must not, because the PDF outlives the app's access control. A **person whose `hidden` is `true` gets NO person-book — the request is refused.** Photos of a hidden person never appear in **any** book (event, series, or person). This is the safety-critical property, pinned by tests (§10).
3. **Scope v1 = auto-layout + exclude (no reorder).** Auto-generate cover + story + chronological captioned grid (person-book adds the history section). A kurator may mark specific eligible photos **excluded** before export. Reorder / drag-to-arrange is a later phase. The exclusion model is delegated to me ("recommend the simplest correct model"); §4 recommends **request-scoped `excludeIds`** — one of the two models the decision offered ("a small join or a per-request exclude list") — and records the persisted-collection alternative as deferred. This is the one place the design chooses "no persistence, no schema"; see §4 and the single open question (§13).

## 3. The one safety property

For **every** book, the set of photos the document is built from is **exactly**:

```
subject match  (event == id  |  event.series == id  |  people contains id)
AND _status == 'published'
AND hasHiddenPerson != true
AND deletedAt does not exist
MINUS excludeIds        (exclude can only REMOVE)
```

fetched with **`overrideAccess: true`** and the hand-written filter — **not** `overrideAccess: false` + the kurator `user`, because a kurator's `canReadPhoto` short-circuits to `true` and would leak hidden-person/draft/binned photos into the export. This mirrors the kiosk exactly: the one place the codebase deliberately overrides access, made safe **only** by reconstructing the consent filter by hand.

Consequences that fall out of the definition:

- A **hidden-person** photo of the subject is **absent even if its id is NOT in `excludeIds`** — the filter removes it before `excludeIds` is ever consulted, and `excludeIds` only ever *subtracts*, so nothing can force it back in.
- A **draft** or **binned** photo never appears, even the kurator's own.
- A **person book of a hidden person is refused** (no PDF, HTTP 403) — the subject themselves has withdrawn consent.
- The generating kurator seeing more in the app changes nothing about the file: the export is filtered as if by a member's eyes, then further as if hidden-person photos did not exist at all.

To make drift structurally impossible, the filter lives in exactly one place — **`fotobuchPhotoWhere()` in `src/lib/fotobuch-query.ts`** — the direct sibling of `kioskPhotoWhere()`, and the photo set is assembled by one shared builder **`collectFotobuchPhotos()`** that both the endpoint and the tests call. Neither surface constructs the `where` inline. **[Empfehlung]**

## 4. Exclusion model — request-scoped `excludeIds` **[Empfehlung]**

The decision offered two models ("a small join or a per-request exclude list") and asked for the simplest correct one. **Recommend the per-request exclude list: `excludeIds` travels in the generate request body; nothing is persisted; no new collection, no schema, no migration.**

Why this is the simplest *correct* model for v1:

- The book **regenerates deterministically** from the consent-filtered subject data. Exclusion is a light curation gesture ("leave these few out this time"), not durable state the archive needs to carry.
- Persisting a per-target exclusion set means a new admin-only collection keyed on `(targetType, targetId, photo)`, its own migration + drift entry, access rules, and a consent-coupling question (what a persisted exclusion means once its photo is deleted or its subject hidden) — real machinery for marginal v1 benefit.
- **Reorder (the next phase) will need persisted per-target layout state anyway.** When that lands it should own the persistence model for *both* order and exclusion together, rather than v1 shipping a half-model that reorder then reshapes. Deferring persistence keeps v1 lean and avoids a throwaway schema.
- Aligns with the design note that schema is "minimal or none if exclusions are request-scoped."

`excludeIds` can **only subtract** from the already-consent-filtered set (§3) — it is never unioned into the query, so it can never re-admit a hidden-person photo. **Deferred alternative (recorded, not built):** an admin-only `fotobuch-exclusions` collection `{ targetType: select, targetId: number, photo: rel→photos (FK cascade) }`, unioned with request `excludeIds` at generate time — the natural home for this is the reorder phase.

## 5. Engine assessment — is `@react-pdf/renderer` clean on this toolchain?

The constraint that decides this is the **container**: `node:22-alpine` (musl), in which sharp is compiled from source against system libvips so HEIC decodes. Any dependency that forces a native glibc binary into that image pays the same large, non-obvious price `onnxruntime-node` would have (faces spec §1). So the engine was measured the same way, from its published dependency tree, not assumed.

`@react-pdf/renderer@4.6.1` → the whole tree is **pure JavaScript + one WASM layout engine, no `node-gyp`, no prebuilt `.node` addon, no libc linkage:**

| Package | What it is | Native? |
|---|---|---|
| `@react-pdf/pdfkit` | PDF writer; bundles `fontkit`, `png-js`, `fflate`, `@noble/hashes`/`@noble/ciphers`, `linebreak` | **no** — all pure JS |
| `fontkit@2` | font parsing/subsetting; deps `brotli`, `restructure`, `unicode-trie`, `tiny-inflate`, `dfa`, `unicode-properties`, `clone` | **no** — all pure JS (JS brotli, JS inflate) |
| `@react-pdf/layout` | flexbox layout; dep **`yoga-layout@3.2.1`** | **no native addon** — yoga v3 ships an **Emscripten-compiled WASM/asm.js** module loaded from JS, the same class as `onnxruntime-web`; no `install`/`postinstall` build step in the published package |
| `@react-pdf/image` | image embedding; deps `png-js`, **`jay-peg`** (pure-JS JPEG parser), `@react-pdf/svg` | **no** — and notably **no `sharp`**, so the tree does not pull a second copy of the one native dep this repo deliberately controls |
| `@react-pdf/render`, `@react-pdf/textkit`, `@react-pdf/stylesheet`, `@react-pdf/primitives`, `@react-pdf/reconciler`, `@react-pdf/fns`, `@react-pdf/font` | rendering / text shaping / React reconciler | **no** — pure JS |

**Verified findings, stated like the faces spec's musl finding:**
- **No glibc, no musl question.** There is no compiled `.node` binary anywhere in the tree; `yoga-layout` is WASM/asm.js loaded through JS (`process`-agnostic), so musl-vs-glibc and arm64-vs-x64 are non-questions — the same image runs on the owner's Mac and any x86 VPS, exactly as the WASM face engine does.
- **No second `sharp`.** `@react-pdf/image` decodes JPEG (`jay-peg`) and PNG (`png-js`) in pure JS. It does **not** decode WebP/TIFF/HEIC — a real fidelity gap, closed cleanly in §6.3 by transcoding every photo to JPEG through the repo's existing `sharp` before handing bytes to `<Image>`.
- **The one integration risk, named up front (the faces-style "fiddly part"):** `next build` with `output: 'standalone'` traces JS *imports*; `yoga-layout`'s WASM/asm asset is loaded at runtime, not statically imported, so it can fail to be traced into the standalone bundle — producing a green build and a generator that throws only at first render (the exact silent-fallback class the Dockerfile's HEIC and face probes exist for). Mitigation, mirroring `onnxruntime-web`'s treatment verbatim: `serverExternalPackages: ['@react-pdf/renderer']` in `next.config.ts` (leave it a runtime require), plus `outputFileTracingIncludes` for the yoga asset **if the Task 1 spike shows it missing**, and a **docker-job "Verify react-pdf renders" boot check** analogous to the existing "Verify onnxruntime-web wasm is shipped" step. The int test that renders a real 1-page PDF in CI (§10) is the functional gate that catches this going wrong.

**Image-size impact:** `@react-pdf/renderer` + its tree unpacks to roughly **+5–10 MB** of `node_modules` (fontkit, pdfkit, a small yoga WASM) — to be confirmed at install in Task 1. **No new apk package, no glibc, no second container, no browser.** Contrast the rejected Chromium path (~300 MB + its own shared-lib surface on Alpine).

**Fonts / German typography.** `@react-pdf/renderer`'s built-in default is **Helvetica** (one of the PDF standard-14, WinAnsi/Latin-1 encoding). Every German umlaut (ä ö ü ß Ä Ö Ü) and the en-dash `–` used in date ranges live in WinAnsi, so **the default font renders German correctly with no embedded font** — confirmed against the encoding, and pinned by a unit assertion that a title containing umlauts round-trips. Embedding a bundled TTF (for nicer type) is a later-phase nicety and an explicit non-goal here; if ever added it must be a **bundled** font file (offline, self-hosted ethos), never a Google-Fonts URL.

## 6. Layout & document build

One builder module, `src/lib/fotobuch-document.tsx`, exporting `renderFotobuchPdf(book: FotobuchBook): Promise<Buffer>` and the pure `FotobuchBook` view-model. The endpoint assembles the `FotobuchBook` from consent-filtered data (§3) and hands it to the builder; the builder does no data fetching (keeps it unit-testable and free of access-control responsibility).

### 6.1 Page structure (A4, `size="A4"`)

- **Cover** — title = subject name; subtitle = date range (§6.2). The book's photos are ordered **oldest→newest** (`sort: 'dateSortKey'` ascending) throughout, so a book reads chronologically; the auto cover image is that first (oldest) eligible photo, full-bleed, transcoded like any other. Footer „Stamm-Greif-Archiv". No cover-image picker (non-goal).
- **Story / bio** — for an event or series: `story` (Lexical richText) → plain text (§6.4) under a „Geschichte" heading. For a person: `bio` (already a plain `textarea` string — no conversion) under „Über". Omitted when empty.
- **Person history section** (person book only) — reuses the `personen/[id]` data shapes exactly:
  - **Gruppen:** memberships (`sort: 'vonYear'`), each `group.name · de.person.rollen[role] · formatRange({von,bis})` — the same `formatRange` (`src/lib/time-range.ts`) and role labels the person page uses.
  - **Ereignisse:** attended events (`attendance` where `person == id`), event names.
- **Photo pages** — the same oldest→newest chronological set as the cover (`sort: 'dateSortKey'` ascending), **[Empfehlung]** 2 columns × 3 rows per A4 page; each cell = the transcoded image + `caption` + the fuzzy-date label under it (`parseFuzzyDate(...).label`). react-pdf paginates the grid automatically (`wrap`).
- If the eligible set exceeds the cap (§6.5) the grid renders the first `FOTOBUCH_MAX_PHOTOS` and the cover notes the truncation (`de.fotobuch.truncated`).

### 6.2 Title / date-range formatting (pure, unit-tested)

`fotobuchTitle(book)` and `fotobuchDateRange(book)` in `src/lib/fotobuch-title.ts`:
- **Event:** `parseFuzzyDate({ precision: datePrecision, value: dateValue }).label` (e.g. „12.08.1989", „1989", „1980er Jahre", „Datum unbekannt").
- **Series:** min–max of member events' fuzzy years → `formatRange`-style „1985–2025"; single-year → that year; none datable → empty subtitle.
- **Person:** subtitle = birth year if present („* 1974"), else empty. Title = `person.name`.

### 6.3 Images — on-disk read + sharp transcode (reuse the established pattern)

Per included photo, resolve the file exactly as `detectFaces.ts`/the kiosk image route do — `path.resolve(process.cwd(), 'photos')`, prefer `sizes.web.filename`, fall back to `filename`, `path.basename()` the name — then:

```
sharp(bytes).rotate().resize({ width: 1200, withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer()
```

`rotate()` bakes EXIF orientation; the JPEG output is what `jay-peg` (react-pdf's decoder) reliably reads, closing the WebP/TIFF/PNG-alpha gap in one step and bounding each embedded image to print-sensible size. **ENOENT / decode failure on one photo is a soft skip** (logged, that cell omitted) — one missing file must never fail the whole book, the same non-fatal posture as the kiosk file reads. Buffers are held only for the duration of the render (a few hundred × ~150 KB downscaled JPEGs = tens of MB, transient; fine on a 2 GB VPS).

### 6.4 richText (Lexical) → plain text — fidelity limits stated

`Events.story` is a Lexical `SerializedEditorState`. `lexicalToPlainText(state): string` in `src/lib/lexical-text.ts` recurses the node tree, concatenating `text` leaf nodes, treating `paragraph`/`heading`/`listitem` as block separators (blank line / newline), ignoring everything else. **v1 fidelity limits, documented:** no bold/italic/underline, no links (link text is kept, the URL dropped), no images-in-richtext, no nested list markers — **paragraphs and line breaks only.** That is sufficient for a printed story and avoids re-implementing a Lexical renderer; richer story typography is a later-phase item. Pure function, unit-tested (nested nodes, empty state, missing `root`).

### 6.5 Sync generation with a bounded cap — no jobs system **[Empfehlung]**

Generation is **synchronous** inside the request. The archive is ~10k photos, but a **single** event/series/person book is bounded to dozens–low-hundreds of photos; react-pdf renders that to a Buffer in a few seconds. A hard cap **`FOTOBUCH_MAX_PHOTOS = 300`** (module constant in `src/lib/fotobuch-query.ts`, **no new env** — keeps `.env` stable, a stated non-goal) bounds worst-case work and memory. The jobs system (used for face detection because inference is unbounded background work) is **not** needed: this is a bounded, kurator-initiated, request-scoped render whose result is streamed straight back. If a future "whole-archive book" ever appears it can move to jobs; v1 does not need it.

## 7. Endpoint — `POST /api/fotobuch`

A **Next route handler** at `src/app/api/fotobuch/route.ts` (the `/api/health`, `/api/kiosk/*` class — a static route that wins over Payload's `/api/[...slug]` catchall; there is no `fotobuch` collection to hang a Payload endpoint on). Body JSON `{ type: 'event'|'series'|'person', id: number, excludeIds?: number[] }`.

1. **Auth:** `getUser()`; reject non-kurator/admin (401 if no user, 403 otherwise) — the same operator gate the kiosk mint route and `/gesichter` use.
2. **Person-hidden refusal:** for `type: 'person'`, load the person with `overrideAccess: true`; if `person.hidden` → **403** (`de.fotobuch.refusedHidden`), no PDF. A withdrawn-consent subject gets no book.
3. **Consent set:** `collectFotobuchPhotos({ type, id, excludeIds })` — builds the subject `where`, ANDs `fotobuchPhotoWhere()`, runs `overrideAccess: true`, then subtracts `excludeIds` **in code** (never in the query). Returns the ordered photo docs (capped).
4. **Build:** assemble the `FotobuchBook` (subject meta + story/bio + person history for person books + the photo list) → `renderFotobuchPdf(book)`.
5. **Respond:** `200` `application/pdf`, `Content-Disposition: attachment; filename="<subject-slug>.pdf"` (filename derived from the subject name, sanitised like the kiosk download route's `replace(/[^\w.\-]/g, '_')`), `Cache-Control: no-store`.
6. Empty eligible set → still a valid PDF (cover + „keine Fotos") rather than an error — a book of a subject with no public photos is a legitimate, if thin, artifact.

The endpoint **re-runs the consent filter server-side regardless of `excludeIds`**; `excludeIds` can only remove. A hidden-person photo can never be forced in.

## 8. Exclude UX — `/fotobuch` page

A members-gated (kurator/admin) page in the `(frontend)` group, built the house way: server component for auth + data, a small `'use client'` form for the interaction (the `FaceReviewForm` / `KioskAdmin` pattern).

- **`src/app/(frontend)/fotobuch/page.tsx`** (server component): `getUser()` → `redirect('/anmelden')` if none, `notFound()` if not kurator/admin (same idiom as `/gesichter`, `/kiosk-admin`). Reads `?type=` & `?id=` (linked to from the event and person pages via a „Buch erstellen" link — a per-event/per-person entry point). With a target selected, fetches the **eligible** photos via the same `collectFotobuchPhotos({ type, id })` (no excludes) so the list the kurator sees is already the consent-filtered set. Renders subject title + the eligible thumbnails.
- **`src/app/(frontend)/fotobuch/FotobuchForm.tsx`** (`'use client'`): each eligible photo shows with an „ausschließen" checkbox (default unchecked = included). „PDF erzeugen" POSTs `{ type, id, excludeIds }` (the checked ids) as JSON to `/api/fotobuch`, receives the `application/pdf` blob, and triggers a download (`URL.createObjectURL` + a synthetic `<a download>`). German strings from a new `de.fotobuch` group; a re-entrancy guard on the submit button (the `UploadForm`/`FaceReviewForm` pattern). Thumbnails use the existing authed image path (this page is authed, so `photo.sizes.thumbnail.url` works — no kiosk token needed).

Because the page fetches through the same `collectFotobuchPhotos` filter, a hidden-person photo of the subject **is not even listed** for exclusion — the kurator cannot see it here any more than the PDF can contain it.

## 9. Schema & data

**None.** No new collection, no new field, no migration (the request-scoped exclusion model, §4). CI's drift check (`migrate:create ci_drift_check --skip-empty`) must therefore stay clean — a green no-op, and if this design ever *does* grow a schema (the deferred persisted-exclusion collection) that is when a migration + drift entry appears, generated with `pnpm payload migrate:create` per `betrieb.md`. No `.env` change (§6.5).

## 10. Testing

**Unit** (`src/lib/**`, run by `test:unit`, no server, no browser):
- `lexicalToPlainText`: paragraphs joined with blank lines; nested nodes; empty/missing `root` → `''`; link node keeps its text.
- `fotobuchTitle` / `fotobuchDateRange`: event exact/year/decade/unknown labels via `parseFuzzyDate`; series min–max range; single-year series; person birth-year subtitle; German umlauts survive.
- `fotobuchPhotoWhere()`: asserts the exact AND-terms (`published`, `hasHiddenPerson != true`, `deletedAt` absent) and — the regression pin — that it does **NOT** contain `kioskFreigegeben` (it is the kiosk filter *minus* the allowlist) and contains no `or`.

**Integration** (`tests/int/fotobuch.int.test.ts`, app on the test DB, the pattern the other int suites use) — the **safety property (§3) is the point**:
- **Role gate:** a `mitglied` POST → 403/404; unauthenticated → 401/redirect; kurator and admin → 200.
- **Hidden-person photo never in output, even when NOT excluded:** create a published photo of the subject tagging a hidden person; POST **without** its id in `excludeIds`; assert it is **absent** from the built photo set. Asserted primarily on the **set** `collectFotobuchPhotos` returns (deterministic, no PDF parsing), and secondarily that the response is a valid PDF whose byte length does not grow with that photo present vs. absent.
- **Person book of a hidden person → refused:** `type: 'person'` on a hidden subject → **403**, no PDF.
- **Exclude removes:** an eligible photo whose id **is** in `excludeIds` is absent from the set; the same photo without the exclude is present (proves exclude is what removed it).
- **Draft & binned absent:** a draft photo and a `deletedAt` photo of the subject are both absent.
- **Positive control / valid PDF:** a proper event/series/person target returns `content-type: application/pdf`, `content-disposition: attachment; filename=...pdf`, and a body starting with the `%PDF-` magic bytes and length > 0 — **this test also exercises the real react-pdf render path in CI**, which is the functional probe for the yoga-WASM tracing risk (§5).

**PDF inspectability, assessed:** react-pdf produces a real PDF, but asserting *captions inside* it means parsing PDF internals (a new dep like `pdf-parse`). **Recommend not adding one:** assert the consent property on the **photo set the document is built from** (via the shared `collectFotobuchPhotos` builder the test calls directly) plus the `%PDF-`/length/headers of the produced bytes. The set is the load-bearing safety artifact; the bytes prove it rendered. This keeps the test dep-free and the assertion precise.

**CI:** pure JS — the int suite runs in the existing required `test` job with **no browser and no new service**. The `docker` job additionally gets a "Verify react-pdf renders" boot check (§5) alongside the existing onnxruntime-web wasm verification. `e2e` untouched (optional: a kurator opens `/fotobuch?type=event&id=…` and downloads — kept optional; the int safety tests are the ones that matter).

## 11. Rollout

One PR, branch `p2-fotobuch`, required checks unchanged (`test`, `e2e`, `docker`, `hygiene`) plus the drift check staying clean (§9). No VPS blocker: no new container, no new heavy/native dependency (react-pdf is pure JS/WASM), no new service, **no new env**. Ships in the existing app image (+5–10 MB, §5). Once the image is deployed the feature is live — no infrastructure switch. Migration discipline is a no-op here (no schema), but the standard **`docker compose build migrate` before restart** note in `betrieb.md` still applies to the deploy in general (the stale-migrate-image gotcha).

New `betrieb.md` German section **„Fotobuch (PDF-Export)"**, slotted after „Kiosk & Zeitleiste" and before „Monitoring", in the file's existing shape — copy-pasteable steps, **bold** for the consent rule that must not be missed:
- **Fotobuch erzeugen:** open `/fotobuch` (or „Buch erstellen" on an event/person page) as kurator/admin, pick the target, tick any photos to leave out, „PDF erzeugen" → the browser downloads the A4 PDF.
- **Konsens-Regel (fett):** the book contains **only** published, not-hidden, not-binned photos; **a hidden person's photos never appear in any book, and a hidden person gets no book at all — even for a kurator, and even if the photo was not explicitly excluded.** The export is filtered harder than the app's own view because the PDF leaves the system.
- **Grenzen:** at most `FOTOBUCH_MAX_PHOTOS` (300) photos per book (oldest-first, truncation noted on the cover); the story is rendered as **plain text** (no bold/links/lists in v1); the cover photo is auto-picked (first chronological); **no reorder** in v1; images are downscaled for print.

## 12. Non-goals (explicit)

Reorder / drag-to-arrange UI · custom themes/templates/cover layouts · cloud print or print-shop integration · cover-image picker (auto-pick first photo) · multi-language (German only) · rich Lexical fidelity (bold/links/lists/images) · embedded custom fonts · a persisted exclusion/layout store (deferred to the reorder phase, §4) · the jobs system for generation (bounded sync, §6.5) · parsing PDF content in tests (§10).

## 13. Open questions for the owner — one

| Question | My recommendation |
|---|---|
| **Exclusion persistence.** Decision 3 says „persist exclusions" but also offers „a per-request exclude list" as one of the two models and delegates the choice. v1 as specced uses **request-scoped `excludeIds` (no persistence, no schema, no migration)** — the leanest correct model, and reorder (next phase) will own the persisted per-target layout+exclusion store anyway. | **Ship request-scoped for v1.** If you want a kurator's exclusion choices to *survive* between exports before reorder lands, say so and §4's deferred `fotobuch-exclusions` collection (one small admin-only join + migration + drift) becomes a task instead — consent safety is identical either way (exclude only ever subtracts from the §3 set). |

## 14. Files touched

| Piece | File |
|---|---|
| Consent filter + builder + cap | `src/lib/fotobuch-query.ts` — `fotobuchPhotoWhere()`, `collectFotobuchPhotos()`, `FOTOBUCH_MAX_PHOTOS` |
| Pure helpers | `src/lib/lexical-text.ts` — `lexicalToPlainText()`; `src/lib/fotobuch-title.ts` — `fotobuchTitle()`, `fotobuchDateRange()` |
| PDF document | `src/lib/fotobuch-document.tsx` — `renderFotobuchPdf()`, `FotobuchBook` view-model, react-pdf components; image transcode helper |
| Endpoint | `src/app/api/fotobuch/route.ts` — `POST` (auth, refusal, consent set, render, stream) |
| Frontend | `src/app/(frontend)/fotobuch/page.tsx`, `.../fotobuch/FotobuchForm.tsx`; „Buch erstellen" links on the event & person pages; `de.fotobuch` group + nav entry in `src/messages/de.ts` |
| Build | `next.config.ts` (`serverExternalPackages: ['@react-pdf/renderer']`, `outputFileTracingIncludes` if the spike needs it); `Dockerfile`/CI "Verify react-pdf renders" step |
| Deps | `@react-pdf/renderer` — one dependency, pure JS/WASM, no native build (§5) |
| Ops | `docs/betrieb.md` — „Fotobuch (PDF-Export)" section |
| Tests | `tests/unit/lexical-text.test.ts`, `tests/unit/fotobuch-title.test.ts`, `tests/unit/fotobuch-query.test.ts`, `tests/int/fotobuch.int.test.ts` |
| Migration | **none** (§9) |
</content>
