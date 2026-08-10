# Face Detection (in-process ONNX) — Design

**Date:** 2026-08-09 (rev. 2 — engine switched)
**Status:** DRAFT — awaiting owner sign-off. Three owner decisions are fixed and not re-opened here:

1. **No CompreFace.** Rev. 1 of this spec researched it as directed and the research argued against
   it: upstream frozen (v1.2.0, Aug 2023; last commit Oct 2024), x86+AVX only with no ARM64 images,
   and a 2 GB → 4 GB VPS tier bump. The owner accepted that finding and switched the engine to
   **in-process JS/ONNX detection + embedding inside the app**. §1 picks the concrete library and
   models.
2. **Embeddings live in our own Postgres**, on the `face-suggestions` collection; matching is cosine
   similarity computed in-process against confirmed embeddings. §3–§4.
3. **No separate biometric opt-in field.** `people.hidden` („Person verbergen (Einwilligung
   widerrufen)") remains the single consent boundary. *Trade-off, stated once:* consent to be in the
   archive is treated as covering the biometric processing derived from those photos, which is a
   broader reading of Art. 9 Abs. 2 lit. a than a dedicated opt-in would be — the mitigation is that
   withdrawal is immediate, total and irreversible (§7). A written DSFA remains recommended (§9).
4. **Enable immediately on the owner's live instance.** `FACE_DETECTION_ENABLED` stays as an env
   flag for engineering hygiene and as an operator kill switch, documented as `true` for this
   deployment; the ship-dark-until-the-DSFA-exists posture stays in betrieb.md as the recommended
   default for *other* deployments of this codebase.
5. **Full backfill at enable.** The whole existing archive is processed once, as an admin-triggered
   Payload job task — the same machinery the post-restore reconciliation needs, pointed at every
   eligible published photo instead of at the hidden persons (§7, §11).

**Phase:** P2.3, after P2.1 (EXIF/Papierkorb) and P2.2 (Duplikaterkennung).
Everything marked *Empfehlung* is my recommendation and open to change.

## Goals

1. After a photo is **published**, faces in it are detected, embedded, and — where the archive
   already knows the person — a *suggestion* is created. A kurator confirms or rejects; nothing is
   ever tagged automatically.
2. Confirming adds the person to `photos.people` (feeding the existing `hasHiddenPerson` recompute)
   and promotes that face's embedding into the person's face index, so later photos match better.
   The index bootstraps itself from curator work — there is no enrollment UI and no model training.
3. **No new container, no new service, no network call.** Detection is a function call inside the
   app, on the existing jobs queue. Biometric data never leaves the app process and its own
   database.
4. **The stack keeps working when the models are absent.** Missing model files degrade to „no
   suggestions"; uploads, publishing, browsing and health are untouched.
5. **Consent is enforced by deletion, not by filtering.** `people.hidden = true` hard-deletes every
   embedding and every suggestion naming that person. Deleting a photo deletes the face data derived
   from it. §7 also states honestly what backups still hold, and for how long.
6. Members never see face data — not suggestions, not boxes, not similarity scores, not embeddings.
7. The GDPR position of a German Verein processing Art.-9 data about minors is written down in
   `docs/betrieb.md`, in that file's existing German.

**Non-goals (explicit):** auto-tagging without human confirmation · member-visible suggestions of any
kind · the „Wer ist das?" crowd-ID workflow (scout-archive spec §5, *Later* tier) · age/gender/emotion
inference (more Art.-9 data, zero benefit) · GPU · face *search* (already `photos.people`) ·
retraining or fine-tuning any model · detection on drafts (§5).

## 1. Engine choice

The constraint that decides this is our **container**: `node:22-alpine` (musl), in which we already
compile sharp from source against the system libvips so HEIC decodes. That Dockerfile is
hard-won — three stages of comments record two silent-failure modes already found and fixed — and
any engine that forces it off Alpine is paying a large, non-obvious price.

### The candidates, measured rather than assumed

| | `onnxruntime-node` | `@vladmandic/human` | `@huggingface/transformers` | **`onnxruntime-web` (WASM), in Node** |
|---|---|---|---|---|
| Latest | 1.27.0, 2026-06-19 | 3.3.6, 2025-08-26 (repo pushed 2025-12-13) | 4.2.0, 2026-04-22 | 1.27.0, 2026-06-19 |
| Native deps | **yes** | via TFJS backend | via `onnxruntime-node` | **none** |
| musl / Alpine | **no** — see below | no (`tfjs-node`) / yes (tfjs-wasm) | inherits ORT-node's problem | **yes** |
| arm64 + x64 | both (glibc only) | backend-dependent | backend-dependent | **identical everywhere** |
| Install weight | 104 MB tarball, **258 MB** unpacked `bin/` | TFJS + models | ORT-node + ORT-web + **a second `sharp`** | 30 MB tarball, one 13.5 MB `.wasm` shipped |
| Health of the runtime under it | active | Human active, but its Node backend `@tensorflow/tfjs-node` last published **2024-10-21** | active | active |

**The musl finding, verified directly rather than from an issue tracker.** I downloaded the
`onnxruntime-node@1.27.0` tarball and listed it:

```
package/bin/napi-v6/linux/x64/{onnxruntime_binding.node, libonnxruntime.so.1}
package/bin/napi-v6/linux/arm64/{...}
package/bin/napi-v6/darwin/arm64/{...}
package/bin/napi-v6/win32/{x64,arm64}/{...}
```

One Linux flavour, and it is glibc: `strings` on the x64 addon yields `libc.so.6`,
`libstdc++.so.6`, `libgcc_s.so.1` and versioned `GLIBC_2.2.5 … GLIBC_2.14`, and
`libonnxruntime.so.1` requires up to `GLIBC_2.27`. Nothing in the package mentions `musl` or
`alpine`. **It cannot load in our image.** That also rules out `@huggingface/transformers`, which
depends on it directly (and which would additionally pull a *second* `sharp` into a tree where we
deliberately control exactly one).

**The counter-finding that makes this easy.** `onnxruntime-web@1.27.0` is not browser-only. Its
`package.json` `exports` map has a first-class **`node` condition**:

```json
".": { "node": { "import": "./dist/ort.node.min.mjs", "require": "./dist/ort.node.min.js" }, … }
```

`ort.node.min.mjs` is a purpose-built 27 KB Node bundle that imports `node:fs` / `node:fs/promises`,
branches on `process.versions.node`, and loads `ort-wasm-simd-threaded.wasm` (13.5 MB, SIMD baked in)
off the filesystem. It is pure JS + WebAssembly: **no libc linkage at all**, so musl vs glibc and
arm64 vs x64 stop being questions. It is the same fallback the transformers.js project points musl
users at, and it is published and versioned in lockstep with `onnxruntime-node` by the same team.

*Empfehlung:* **`onnxruntime-web`, WASM execution provider, imported through its Node entry.**

Rejected, with reasons: **`onnxruntime-node`** — musl, decisive; **`@huggingface/transformers`** —
inherits that, plus a duplicate `sharp`, plus no first-class face-detection/recognition pipeline;
**`@vladmandic/human`** — its Alpine-viable path is TFJS-WASM, i.e. the *same* WASM trade-off reached
through two stacked dependencies instead of one, on a Node backend package that has not shipped in
almost two years, and its face-description head is built for description/liveness rather than 1:N
identity matching.

Honest cost of the recommendation: **WASM is slower than native**, order 3–5×. Rough expectation for
one photo — detector at 640×640 plus one 112×112 embedding per face — is a few hundred milliseconds
to ~1 s. On a background job queue for a family archive that is irrelevant. To be measured, not
assumed. Start with `ort.env.wasm.numThreads = 1`: multi-threaded WASM spawns worker threads through
emscripten's pthread shim, which is exactly the sort of thing that misbehaves under Next's
standalone output, and single-threaded is already fast enough. Raising it is a one-line follow-up
once measured.

### Models

*Empfehlung:* the two files we actually need out of **InsightFace's `buffalo_s`** pack:

| File | Role | Size | Notes |
|---|---|---|---|
| `det_500m.onnx` | detector — labelled *RetinaFace-500MF* in the model zoo, SCRFD-family | **2.52 MB** | outputs, per stride 8/16/32: score, bbox, **5 keypoints**; needs NMS on our side |
| `w600k_mbf.onnx` | recognition — *MBF@WebFace600K* (MobileFaceNet trained with ArcFace) | **13.6 MB** | 112×112 input, **512-d** embedding |

≈ **16 MB**, against 326 MB for the `buffalo_l` pack, whose extra accuracy we do not need: `buffalo_s`
reports LFW 99.70 % / IJB-C(E4) 95.02 %, and every match here is checked by a human before it means
anything. We take only these two files — not the pack's 2d106/3d68 alignment or gender/age models,
which we have no use for and which would be additional Art.-9 inference.

**Licence, stated plainly because it is a real difference from rev. 1:** the InsightFace model zoo
says „ALL models are available for non-commercial research purposes only." A Verein photo archive is
non-commercial, so this fits — but it is *not* the Apache-2.0-all-the-way-down position CompreFace
had, and it belongs in betrieb.md. Mitigation: everything model-specific (letterboxing, stride
decoding, NMS, the 5-point alignment, output shape) is confined to `src/lib/face-model.ts` behind a
`detectFaces(buffer) → {box, kps, score}[]` / `embed(alignedCrop) → Float32Array` interface, so
swapping in different weights later is a contained change.

**The fiddly part, named up front:** ArcFace embeddings are only accurate on a face crop **aligned by
a similarity transform from the detector's 5 keypoints to ArcFace's standard 112×112 reference
points**. A plain box crop degrades matching badly and silently. This is the main implementation
risk in the whole feature; it is also why we need the detector's `kps` output and not just boxes, and
why the acceptance check in §10 is „same person, two photos → cosine above threshold" rather than
„a box was found".

## 2. Runtime integration

No new container, no compose profile, no new env-driven service. Three concrete integration points:

**Model files — bundled at build, verified at build.** *Empfehlung:* a dedicated Dockerfile stage
downloads the two `.onnx` files from a pinned URL and **verifies a SHA-256 for each** before the final
stage copies them to `/app/models/faces`. Not committed to git: they are 16 MB of binary that would
sit in the repo's history forever, and this repo is public. `scripts/fetch-face-models.sh` does the
same fetch+checksum for local `pnpm dev` into a `.gitignore`d directory, and CI calls it (cached with
`actions/cache` keyed on the checksums).

**A build-time probe, modelled on the existing HEIC probe.** The Dockerfile's HEIC gate exists
because two separate silent-fallback failures shipped green builds. The same class of failure applies
here — a missing `.wasm`, an untraced file, a wrong model path — and would equally produce a
successful build and a feature that quietly never suggests anything. So the `run` stage ends with a
real inference against a committed fixture and fails the build if it finds no face:

```dockerfile
COPY tests/fixtures/gesicht.jpg /tmp/face-probe.jpg
RUN node -e "import('./probe-faces.mjs')"   # ≥1 box, 512-d embedding, else exit 1
```

The fixture must be a **public-domain portrait** — this repository is public, so it may not be a
Verein member or any identifiable private person. Sourced and attributed in the fixtures directory.

**Next.js file tracing.** `next build` with `output: 'standalone'` traces JS imports; a `.wasm` asset
and a model directory are not imports. Two entries in the already-modified `next.config.ts`:
`serverExternalPackages: ['onnxruntime-web']` so Next leaves it as a runtime require, and
`outputFileTracingIncludes` for `node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.{wasm,mjs}`.
At runtime we set `ort.env.wasm.wasmPaths` to that absolute directory rather than relying on
resolution. The build probe is what catches this going wrong.

New env keys — `.env.example` grows from 3 to 7:

| Key | Default | Meaning |
|---|---|---|
| `FACE_DETECTION_ENABLED` | `true` | operator kill switch that does not require deleting files |
| `FACE_MODELS_DIR` | `/app/models/faces` | where the two `.onnx` files live |
| `FACE_SIMILARITY_THRESHOLD` | `0.40` | cosine, see §4 |
| `FACE_DET_THRESHOLD` | `0.5` | detector score floor |

Image-size impact: **+~30 MB** (16 MB models, 13.5 MB wasm), no new apk packages, no glibc, no second
container. For contrast, `onnxruntime-node` alone unpacks to 258 MB and CompreFace was multiple GB
across three containers.

## 3. Data model

One new collection. **No new stored field on `photos` or `people`** (admin-UI descriptions aside), so
no `_photos_v` twin columns — compare the phash migration, which had to touch both tables.

**`face-suggestions`** — `labels: { singular: 'Gesichts-Vorschlag', plural: 'Gesichts-Vorschläge' }`,
`admin.group: 'Archiv'`, no drafts, no soft-delete.

| Field | Type | Notes |
|---|---|---|
| `photo` | rel → `photos`, required, indexed | FK `ON DELETE cascade` |
| `boxXMin` `boxYMin` `boxXMax` `boxYMax` | number | **normalised 0…1**, so one row crops correctly from `thumbnail`, `web` or the original |
| `boxProbability` | number | detector score |
| `embedding` | **`json`** (jsonb), nullable | **512 L2-normalised floats, rounded to 6 decimals** — full precision is pointless for cosine and doubles the row |
| `suggestedPerson` | rel → `people`, nullable | the match; a kurator may correct it at confirm time |
| `similarity` | number, nullable | null when nothing cleared the threshold or the index was empty |
| `status` | select `offen` \| `bestaetigt` \| `abgelehnt`, default `offen`, indexed | ASCII in the DB, German in the UI |
| `confirmedBy` | rel → `users`, nullable | |
| `confirmedAt` `detectedAt` | date | |
| `sourceVariant` | text | `'web'` \| `'original'` — which file the box was measured against |

The embedding is computed **once, during detection**, and stored on the row from the start. Confirming
therefore performs no inference and no second crop — it only flips `status`. This is a genuine
simplification over rev. 1, where confirming had to crop and POST an example to an external service
that might be down.

**Retention inside the collection**, so open suggestions are not an unbounded biometric pile:

- `abgelehnt` → **`embedding` is set to null** immediately. The row survives as a tombstone purely so
  a re-run's IoU check does not resurrect the same box; the biometric payload is gone.
- `offen` older than 180 days → the existing Papierkorb purge task also nulls their embedding and
  marks them `abgelehnt`. One extra query in a job that already runs.
- `bestaetigt` → the embedding is retained; it *is* the person's face index (§4).

**Single source of truth:** everything is our Postgres. There is no second system, so the divergence
and reconciliation rules rev. 1 needed — and the rebuild task that backed them — are gone entirely.

## 4. Matching

The face index is **derived, not stored separately**: it is exactly the set of
`status='bestaetigt'` rows with a non-null `embedding` and a `suggestedPerson`.

Per detected face: cosine similarity against every indexed embedding (both sides L2-normalised, so
this is a dot product); group the scores by person and take each person's **best** score; if the top
person clears `FACE_SIMILARITY_THRESHOLD`, write `suggestedPerson` + `similarity`, otherwise write
the box with `suggestedPerson: null` and let the kurator pick from the dropdown.

**Threshold: start at 0.40, tune later** — flagged as tune-later, as instructed. InsightFace's own
guidance is that 1:1 cosine thresholds for their recognition packs land in the **0.30–0.45** range at
FMR 1e-4…1e-5 over L2-normalised embeddings, and that the right value depends on the model and the
population, so it should be recomputed rather than inherited. Ours is a *suggestion* threshold with a
human gate behind it, so the cost asymmetry is unusual: a false positive costs a kurator one click,
a false negative costs a suggestion that never appears. That argues for the permissive end of the
band once there is real data to look at. `FACE_SIMILARITY_THRESHOLD` is env-tunable without a deploy
precisely so this can be walked in.

**Scale, honestly.** This is a linear scan in JS. At the archive's realistic size — hundreds to a few
thousand confirmed faces — loading `{id, suggestedPerson, embedding}` with `depth: 0` costs a few MB
and the scan costs single-digit milliseconds; irrelevant next to the inference itself. It stops being
free somewhere around **10 000 confirmed faces**, where the answer is `pgvector` and an index — a
Later item, not this design, and cheap to reach because the embeddings are already in Postgres.
Stated in betrieb.md so nobody discovers it by surprise.

`cosineSimilarity`, `l2Normalise` and `bestMatchPerPerson` are pure functions in `src/lib/faces.ts`,
covered by `test:unit`'s existing `src/lib/**` coverage include.

## 5. When detection runs — and why on publish, not on upload

*Empfehlung, unchanged from rev. 1:* **on the draft → published transition, never on a draft.**

The argument for running earlier is real — a kurator moderating in the Payload admin UI would like
suggestions already — and it still loses:

- **Data minimisation.** Member uploads land as drafts and a kurator may delete them unpublished.
  Computing biometric templates for people who may never enter the archive is processing we can
  simply not do. Publishing is when the Verein has decided to keep the picture. (This argument is
  *stronger* now, not weaker: the embedding is persisted at detection time, so running on drafts
  would mean storing Art.-9 data for photos that get thrown away.)
- **One well-defined edge.** A draft is saved many times; `_status` flips to `published` once.
- **Consent state has settled** by then — `hasHiddenPerson`, `people`, date, event.
- **The moderation UI is Payload's admin**, which this project deliberately does not extend, so
  suggestions would have nowhere to appear during moderation anyway. `/gesichter` is a separate
  post-hoc queue by design.

Trigger, in a new `photos` `afterChange` hook `enqueueFaceDetection`:

```
enqueue when  FACE_DETECTION_ENABLED
        and   doc._status === 'published'
        and   (previousDoc?._status !== 'published'  ||  doc.filename !== previousDoc.filename)
        and   doc.hasHiddenPerson !== true
        and   doc.deletedAt == null
```

### Async job, not an inline hook

P2.2 does its phash work inline — a few milliseconds of sharp. This is a few hundred milliseconds to
a second of WASM inference, and it must not sit in the publish request. We already have the P2.1 jobs
system:

| Piece | Shape |
|---|---|
| Task | `src/jobs/detectFaces.ts` — `slug: 'detectFaces'`, `label: 'Gesichter erkennen'`, **no `schedule`** (event-driven), `retries: { attempts: 2, backoff: { type: 'exponential', delay: 30_000 } }` *(exact `retries` shape per Payload 3.87 — verify; the repo has no retry precedent, `purgePapierkorbTask` uses defaults)*. Two attempts, not three: with no network in the path, a second failure is a bug or a missing model, and retrying will not fix either. |
| Enqueue | `req.payload.jobs.queue({ task: 'detectFaces', input: { photoId: doc.id }, queue: 'faces', req })` inside try/catch — **a failed enqueue never fails the publish**, it only calls `recordError` |
| Runner | new `jobs.autoRun` entry `{ cron: '* * * * *', queue: 'faces' }` beside the existing `*/15 * * * *` default queue. Own queue so a slow face job cannot starve the Papierkorb purge; own cadence so suggestions appear within about a minute |

Handler: load the photo with `overrideAccess: true, depth: 0, req` → re-check the guards (state may
have moved since enqueue) → read the file from `/app/photos`, preferring `sizes.web.filename`
(1600 px), falling back to the original where Payload did not generate that size → `sharp` to raw
RGB → detector → per face, align by keypoints and embed → match (§4) → write rows, boxes normalised
against the dimensions actually used.

**Model sessions are loaded once and cached in module scope** — an `ort.InferenceSession` per model,
created lazily on first use behind a promise so concurrent jobs share one load. Cold start is the
first job after a deploy; after that inference is warm.

**Idempotency on re-run:** delete this photo's `offen` rows, then skip any new box overlapping an
existing `bestaetigt`/`abgelehnt` row with **IoU > 0.5**, so a re-run never resurrects a face a
kurator already handled. `boxIoU` is a pure unit-tested function, following `src/lib/phash.ts`.

### Degradation

The story is now just „are the models there":

- `FACE_DETECTION_ENABLED=false`, or `FACE_MODELS_DIR` missing/incomplete → nothing is enqueued;
  `/gesichter` shows one German sentence („Gesichtserkennung ist nicht aktiviert.").
- A model that fails to load or an inference that throws → the job fails after its retry, `recordError`
  logs `msg: 'face-detect-failed'` with the photo id, and **the archive is unaffected**: the photo is
  published, visible, and taggable by hand.
- Health endpoint gains one **informational** field, `faces: 'aus' | 'bereit' | 'Modell fehlt'`, from a
  cached module-scope flag (one `fs.access` per process, then free). **It never influences `status`
  and never changes the HTTP code** — Uptime Kuma must not page the owner over a face model. Said
  as much in betrieb.md.

## 6. Confirm workflow

The frontend is plain server components plus small client forms; there are no custom admin-panel
views in this project and this feature does not add the first one.

**Page `src/app/(frontend)/gesichter/page.tsx`** (server component), using the existing gating idiom
verbatim: `const user = await getUser(); if (!user) redirect('/anmelden')`, then
`if (user.role !== 'admin' && user.role !== 'kurator') notFound()` — `notFound()` rather than 403,
matching how `personen/[id]` hides a hidden person from members.

Query: `status='offen'`, photo not soft-deleted, newest first, `limit: 30`, paginated like the archive
index. **`embedding` is explicitly excluded from the select** — 30 × 512 floats of Art.-9 data has no
business being serialised into an HTML page. Each entry renders:

- **the face crop** — no new image files: a fixed-size `div` with `overflow: hidden` around an
  `<img src={photo.sizes.thumbnail.url}>` whose `width`/`left`/`top` are computed server-side from the
  normalised box. Pure CSS, no canvas, nothing stored.
- caption, fuzzy date, event — enough context to recognise a child from 1987.
- a `<select>` of persons, pre-selected to `suggestedPerson` when similarity cleared the threshold,
  otherwise empty with a „(unbekannt)" placeholder.
- **Bestätigen** / **Ablehnen**, plus **Rückgängig** on already-confirmed rows.

**Client component `FaceReviewForm.tsx`** (`'use client'`), the size and shape of `UploadForm.tsx`:
per-row status, a re-entrancy guard, German strings from a new `de.gesichter` group in
`src/messages/de.ts`.

**Three endpoints**, as Payload custom collection endpoints on `face-suggestions` — the idiom
`Invites` already uses for `POST /api/invites/accept`, which gives us Payload auth, `req` and the
transaction for free:

| Endpoint | Body | Does |
|---|---|---|
| `POST /api/face-suggestions/:id/bestaetigen` | `{ personId }` | role check → **409 if `person.hidden`** (a person whose consent is withdrawn can never be re-indexed through this path) → `suggestedPerson = personId`, `status='bestaetigt'`, `confirmedBy`, `confirmedAt` → add the person to `photos.people` if absent via `payload.update(..., { req })`, which runs the existing `beforeChange` recompute of `hasHiddenPerson`. **No inference, no external call** — the embedding is already on the row. |
| `POST /api/face-suggestions/:id/ablehnen` | — | `status='abgelehnt'`, **`embedding = null`**, `confirmedBy`, `confirmedAt` |
| `POST /api/face-suggestions/:id/zuruecksetzen` | — | undo a confirmation: `status='offen'` and remove the person from `photos.people` (existing hook recomputes). The embedding stays — it is still a valid face, just no longer indexed to that person. |

Because everything is one database in one transaction, a confirm either fully happens or fully does
not. Rev. 1 needed a whole „the tag saved but the example did not" partial-failure state; that state
no longer exists.

**Bootstrapping.** The first time a person appears, the index has nothing for them: `similarity` is
null, the dropdown is empty, the kurator picks the person and confirms — and that row becomes the
person's first indexed face. No enrollment screen, no seeding. Suggestion quality grows with
curation. **Rückgängig on the only confirmed row for a person un-indexes them again**, which is
correct and worth one sentence in betrieb.md so it does not look like a bug.

## 7. Consent coupling, and what backups still hold

The field is `people.hidden` — checkbox, „Person verbergen (Einwilligung widerrufen)". It already
drives `syncHiddenPhotos` (`src/hooks/sync-hidden-photos.ts`).

New sibling hook `src/hooks/purge-face-data.ts`, registered **after** the existing hooks on `People`:

```
afterChange:  [syncHiddenPhotos, purgeFaceDataForHiddenPerson]
afterDelete:  [recomputeHiddenPhotosAfterPersonDelete, purgeFaceDataForDeletedPerson]
```

`purgeFaceDataForHiddenPerson` early-returns unless `hidden` flipped `false → true` (the same guard
shape as `syncHiddenPhotos`), then **deletes every `face-suggestions` row with
`suggestedPerson = id`, whatever the status** — an `offen` row names them, a `bestaetigt` row names
them *and* holds their embedding, an `abgelehnt` row still names them — and logs
`msg: 'face-data-purged'` with the person id and the count. One `payload.delete` with a `where`; no
network, no partial states, and it runs **inside the same transaction** as the flag change, so
withdrawal and purge cannot come apart. Person *deletion* runs the same purge from `afterDelete`
(People has no soft-delete, and the id is on the hook's own arguments).

**Photo deletion** needs no capture hook at all now: the FK `ON DELETE cascade` from
`face_suggestions.photo_id` removes the rows and their embeddings with the photo. Rev. 1's
`beforeDelete`/`req.context` dance existed only to collect ids for an external service; it is gone.
This also means the Papierkorb purge job's bulk `delete({ where })` needs no special handling.

**Soft delete (Papierkorb) deliberately does not purge.** The Papierkorb is reversible and a restored
photo should come back whole. `/gesichter` filters out suggestions whose photo has `deletedAt` set,
so nothing is reviewable in the meantime, and the existing 30-day purge does the hard delete, which
cascades.

**Untagging is not a deletion path.** Removing a person from `photos.people` in the admin UI leaves
the confirmed row and its embedding indexed. If a confirmation was *wrong*, the correct action is
**Rückgängig** on `/gesichter`. betrieb.md documents this and the `photos.people` field description
points at it.

### The honest paragraph about backups

Rev. 1 could put the biometric data in its own volume and exclude that volume from backups, so no
backup could ever resurrect a deleted embedding. **Moving the embeddings into our main Postgres gives
that up**, and betrieb.md must say so rather than imply a cleaner story than we have:

> Die Gesichtsdaten liegen in derselben Datenbank wie alles andere und sind deshalb in den
> Sicherungen enthalten. Wird bei einer Person „verbergen" gesetzt, sind ihre Gesichtsdaten im
> laufenden Betrieb **sofort und endgültig weg** — in bereits erstellten Sicherungen bleiben sie
> aber, bis diese Sicherungen turnusmäßig überschrieben werden (30 Tage lokal wie ausgelagert).
> Danach sind sie auch dort verschwunden. **Nach jedem Restore einer älteren Sicherung muss
> „Gesichtsdaten aufräumen" laufen**, sonst leben die gelöschten Daten wieder.

That last sentence is a real operational requirement, so it gets real machinery rather than a note: a
task `reconcileHiddenFaceData` (no schedule, admin-triggered through the already-admin-gated
`POST /api/payload-jobs`) deletes `face-suggestions` rows for **every** person currently flagged
`hidden`. It is idempotent, it is a no-op on a healthy system, and running it is a numbered step in
the restore recipe in betrieb.md. Its sibling `backfillFaces` is the same machinery aimed the other
way — it walks every eligible published photo and enqueues `detectFaces` for it — and is what
implements the owner's full-backfill decision (§11).

**Irreversibility.** Un-setting `hidden` restores nothing. The person's future photos are simply
tagged by hand again until a kurator confirms a new suggestion, which re-indexes them from scratch.
Stated in the admin-UI description on the `hidden` field, in `de.ts`, and in betrieb.md.

## 8. Access control

| Surface | Rule |
|---|---|
| `face-suggestions` collection | `read/create/update/delete: isKuratorOrAdmin` (`src/access/roles.ts`); job writes use `overrideAccess: true` |
| `embedding` field | additionally `access.read: () => false` — it is never needed by any UI, and a field that no API response can carry cannot leak through one |
| The three endpoints | explicit role check inside each handler, not relying on collection access alone |
| `/gesichter` page | `notFound()` for members |
| Payload admin | members already cannot reach `/admin` (`Users.access.admin` allows admin\|kurator) |
| Photo API responses | unchanged — no field is added to `photos`, so no member-facing shape changes at all |
| Network | there is none. No port, no key, no third party, no egress. Biometric data never leaves the app process and its database. |

An int test asserts a `mitglied` gets 403/404 on all three endpoints, cannot list the collection, and
that `embedding` is absent even from a kurator's REST response — extending the existing role matrix in
`tests/int/access.int.test.ts`.

## 9. GDPR framing (for `docs/betrieb.md`) — not legal advice

Written in that file's existing German, for the non-developer maintainers. Substance:

- A photo alone is ordinary personal data. Running it through automated facial recognition makes the
  derived template **biometric data for the purpose of unique identification**, i.e. a **besondere
  Kategorie nach Art. 9 Abs. 1 DSGVO** — prohibited unless an exception applies. The realistic
  exception for a Verein is **ausdrückliche Einwilligung, Art. 9 Abs. 2 lit. a**, and per the owner's
  decision that consent is the same consent that governs being in the archive at all (`hidden`).
- **Minderjährige:** consent is given by the guardians; Art. 8 DSGVO's 16-year threshold is the usual
  orientation. The archive contains historical photos of children, so this is the part that carries
  the weight.
- **Art. 22 does not apply**, by design: nothing is automated. A suggestion has no effect until a
  human confirms it.
- **Art. 25 (privacy by design/default):** off unless the models are installed; only 512-float
  templates stored, never a face crop; the templates are unreadable through any API
  (`access.read: () => false`); rejected suggestions lose their embedding immediately and stale open
  ones lose it after 180 days; **no processor and no data transfer at all** — with the engine
  in-process there is no third party in the picture, which is a genuine improvement over the
  container-based design and worth stating.
- **Art. 17 / Löschkonzept:** the triggers in §7, their irreversibility, and — plainly — the backup
  retention window and the post-restore step.
- **Art. 30:** face detection is a separate Verarbeitungstätigkeit and belongs in the Verzeichnis —
  purpose, legal basis, categories, retention. Note there explicitly that activation includes a
  **one-off full backfill of the existing archive** (owner decision 5), so the processing covers
  every already-published photo from day one, not only new uploads.
- **Art. 5 Abs. 1 lit. e / Speicherbegrenzung:** the retention rules in §3 (rejected → embedding
  deleted at once; open → embedding deleted after 180 days; confirmed → retained as the index) are
  what keep the backfill from turning into an ever-growing pile of templates for people nobody ever
  identified.
- **Art. 35 Abs. 3 lit. b / DSK-Muss-Liste:** the German supervisory authorities' must-list names
  biometric identification. It is not exhaustive, and a small Verein is arguably not „umfangreich",
  but *biometrics + minors + a single consent boundary rather than a dedicated opt-in* makes a short
  written **Datenschutz-Folgenabschätzung** the defensible choice — the more so now that activation
  includes a full backfill. Advice, explicitly **not** a gate on enabling (owner decision 4).
- **Model licence:** the InsightFace weights are „for non-commercial research purposes only", which a
  Verein archive satisfies. One sentence, so nobody later ships this into something commercial
  without noticing.

## 10. Testing

The engine is now an ordinary npm dependency running in-process, so rev. 1's fake-server apparatus
is gone. Nothing is stubbed.

**Unit** (`tests/unit/faces.test.ts` → `src/lib/faces.ts`, already inside `test:unit`'s
`--coverage.include='src/lib/**'`): `l2Normalise`, `cosineSimilarity` (identical → 1, orthogonal → 0,
opposite → −1), `bestMatchPerPerson` grouping and tie-breaking, threshold behaviour exactly at the
boundary, `normalizeBox` against known dimensions, `boxIoU` (identical / disjoint / half / zero-area),
`similarityTransform` from 5 keypoints to the ArcFace reference points, `roundEmbedding` round-trip.

**Integration** (`tests/int/faces.int.test.ts`), running the **real** models — this is the big
simplification: no HTTP stub, no fixed port, no extra process. Requires `scripts/fetch-face-models.sh`
to have run, which the `test:int` script and the CI step both do.

Cases: publish → rows created with plausible boxes and a 512-length embedding · draft save → **no**
rows · **the acceptance check: two different public-domain photos of the same person → cosine above
threshold, and against a different person → below**, which is the only test that actually proves the
keypoint alignment is right · confirm → `photos.people` updated and the row indexed · a second photo
of that person then gets `suggestedPerson` set automatically · reject → `embedding` is null ·
`mitglied` 403 on all three endpoints, cannot list the collection, never sees `embedding` ·
`people.hidden = true` → every row for that person gone, in the same transaction · photo hard-delete →
rows gone via cascade · `FACE_MODELS_DIR` pointed at an empty directory → nothing enqueued, publish
unaffected, `/api/health` still 200 with `faces: 'Modell fehlt'`. Jobs are triggered explicitly via
`GET /api/payload-jobs/run` as admin — the pattern `tests/int/papierkorb.int.test.ts` already uses —
never by waiting on autoRun.

**Can the real engine run in CI?** Yes, comfortably, and it should. This is a **public** repo, so
`ubuntu-latest` is 4 vCPU / 16 GB; the added weight is a 16 MB cached model download and single-digit
seconds of single-threaded WASM inference per test photo. That is a different universe from rev. 1's
2–3 GB of container pulls plus JVM warm-up, and it means the required `test` job exercises the actual
code path that runs in production rather than a stub of it. No optional workflow, no separate live
job, no manual verification recipe needed.

**E2E: untouched.** The three journeys do not change; `/gesichter` is kurator-only.

**Migration / drift.** One migration, `YYYYMMDD_HHMMSS_face_suggestions`, creating the table, its
status enum, the `jsonb` embedding column and FKs to `photos` (cascade), `people` and `users`. **No
`_face_suggestions_v`** (no drafts) and **no `_photos_v` twin columns** (no field added to `photos`).
Generated with `pnpm payload migrate:create`; CI's drift check must come back clean.

## 11. Rollout

One PR, branch `p2-faces`, required checks unchanged (`test`, `e2e`, `docker`). The `docker` job
builds the image including the model stage and the face probe, so a broken model or wasm path fails
CI loudly instead of shipping quietly.

Unlike rev. 1 there is nothing to switch on at the infrastructure level: once the image is deployed,
the models are in it and the feature is live. **Owner decision 4: it is enabled immediately on this
instance** — `FACE_DETECTION_ENABLED` remains in the code as an operator kill switch and is
documented as `true` here. betrieb.md still records the ship-dark posture (merge with the flag
`false`, flip it once a DSFA exists) as the recommended default for *other* deployments of this
codebase, which is a different situation from the owner's own live archive.

**Owner decision 5: the full backfill runs at enable.** After the redeploy, an admin triggers
`backfillFaces` once; it enqueues one `detectFaces` job per eligible published photo. The
`faces` queue's `autoRun` entry carries a `limit`, so the backlog drains at a fixed, self-throttling
rate rather than saturating the box — a few hundred photos an hour, which for this archive means the
queue is empty within a day and no operator has to babysit it. Progress is observable in the logs
(`msg: 'face-detect'` per photo, `msg: 'faces-backfill-enqueued'` with the total) and in the count of
`offen` rows on `/gesichter`.

New betrieb.md section **„Gesichtserkennung"**, slotted after „Duplikaterkennung beim Hochladen" and
before „Monitoring", in the file's existing shape — copy-pasteable `sh` blocks, **bold** for the thing
that must not be missed, a „Prüfen, ob es läuft:" recipe (`docker compose logs app | grep face-detect`,
plus the `faces` field on `/api/health`), and an explicit „Ein paar bewusste Einschränkungen:" list:

- Ein/Aus via `FACE_DETECTION_ENABLED`, and what „Modell fehlt" on the health endpoint means.
- Datenschutz per §9, including the **model licence** sentence.
- Löschen: what `hidden` destroys, that it is **irreversible**, the **backup-retention paragraph**
  from §7 verbatim, and „Gesichtsdaten aufräumen" (`reconcileHiddenPersons`) as a numbered step in the
  restore recipe.
- Aktivierung: the one-off `backfillFaces` run, what it costs, and how to watch it drain.
- Limits: suggestions are best-effort; a failed job is visible in the logs and just means no
  suggestions for that photo; matching is a linear scan that wants `pgvector` beyond ~10 000
  confirmed faces.
- Resource note, deliberately short because it is now unremarkable: **no extra container, no RAM
  tier bump — the base stack's existing footprint plus roughly 200–300 MB while a face job runs.**
  A 2 GB VPS remains fine. (Rev. 1 needed 4 GB; that requirement is gone.)

## 12. Files touched

| Piece | File |
|---|---|
| Pure helpers | `src/lib/faces.ts` — `l2Normalise`, `cosineSimilarity`, `bestMatchPerPerson`, `normalizeBox`, `boxIoU`, `similarityTransform`, `roundEmbedding`, thresholds |
| Model layer | `src/lib/face-model.ts` — ORT session cache, wasm path setup, letterboxing, stride decoding + NMS, 5-point alignment, `detectFaces()` / `embed()`. The only model-specific file. |
| Collection | `src/collections/FaceSuggestions.ts` + the three endpoints; registered in `payload.config.ts` |
| Jobs | `src/jobs/detectFaces.ts`, `src/jobs/faceMaintenance.ts` (`backfillFaces` + `reconcileHiddenFaceData`); `jobs.tasks` + the new `autoRun` entry (with `limit`) in `payload.config.ts`; the 180-day sweep added to the existing purge task |
| Hooks | `src/collections/Photos.ts` (`enqueueFaceDetection` afterChange); `src/hooks/purge-face-data.ts` wired into `People` |
| Frontend | `src/app/(frontend)/gesichter/page.tsx`, `.../gesichter/FaceReviewForm.tsx`; nav entry + `de.gesichter` in `src/messages/de.ts` |
| Health | `src/app/api/health/route.ts` — informational `faces` field only |
| Build | `Dockerfile` (model-fetch stage + checksums + face probe), `next.config.ts` (`serverExternalPackages`, `outputFileTracingIncludes`), `scripts/fetch-face-models.sh`, `.gitignore`, `.env.example` |
| Deps | `onnxruntime-web` — one dependency, no native build step |
| Ops | `docs/betrieb.md` |
| Tests | `tests/unit/faces.test.ts`, `tests/int/faces.int.test.ts`, `tests/fixtures/gesicht*.jpg` (public domain, attributed), additions to `tests/int/access.int.test.ts`; `package.json` `test:int`; CI model-fetch + cache step |
| Migration | `src/migrations/YYYYMMDD_HHMMSS_face_suggestions.ts` + snapshot |

## 13. Open questions for the owner — none

All four are closed; recorded here so the reasoning survives.

| Question | Outcome |
|---|---|
| Separate biometric opt-in field (`gesichtserkennungErlaubt`)? | **Closed — no.** `people.hidden` stays the single consent boundary (owner decision 3). Trade-off and mitigation in the status block. |
| ARM64 / AVX — where may the engine run? | **Closed — moot.** A WASM engine has no architecture requirement; the same image runs on the owner's Mac and on any x86 VPS, and the 4 GB tier bump rev. 1 needed is gone. |
| Ship dark until a DSFA exists? | **Closed — enable immediately** on this instance (owner decision 4). `FACE_DETECTION_ENABLED` survives as an operator kill switch, and betrieb.md keeps the ship-dark posture as the recommendation for other deployments. The DSFA recommendation in §9 stands as advice, not a gate. |
| Backfill the existing archive? | **Closed — yes, in full, at enable** (owner decision 5), via the admin-triggered `backfillFaces` task. §9's Verzeichnis paragraph names the resulting scope explicitly, and §3's retention rules are what stop it accumulating templates for people nobody identifies. |
