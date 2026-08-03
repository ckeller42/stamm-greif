# Stamm-Greif-Archiv — Design Spec

**Date:** 2026-08-03
**Project:** Web-based photo archive & history system for Stamm Greif (Pfadfinderhorst Greif e.V., Bruchsal)
**Deadline anchor:** 50-Jahre-Jubiläum 2027 (founded 1977)

## 1. Purpose

Build a self-hosted web app that archives ~40–50 years of photos (scanned DIA slides + modern phone captures) and models the organization's history: people, groups (Sippen/Meuten/Trupps), memberships over time, events and event series. The community collaboratively organizes the archive; the app produces the anniversary artifacts (kiosk display, photo books, timeline).

**Not a photo gallery with extras — a scout-history system where photos attach to a real domain model.** Evaluation of existing tools (Immich, Piwigo, Nextcloud+Memories, PhotoPrism, LibrePhotos, Lychee, Damselfly, PiGallery2) concluded none can model people-without-photos, group lifespans, or time-ranged membership; Immich's per-user private-tag model blocks collaborative organizing; no tool ships kiosk-QR or story features. Decision: fully custom, single app.

## 2. Decisions (settled during brainstorming)

| Decision | Choice |
|---|---|
| Buy vs build | Fully custom, one app (option C) |
| Stack | **Payload CMS 3 embedded in Next.js, TypeScript, Postgres** |
| Access | **Invite-only** (admin invite links). No public registration. Not indexed. |
| Collaboration | Shared archive; all members see/contribute to one pool; curators moderate |
| Metadata portability | XMP sidecar write via exiftool (Phase 2); originals never modified |
| Language | German-first UI, real vocabulary (Sippe, Meute, Lager, Fahrt); i18n-capable |
| Theming | Greif/raptor motif; fallback archival palette (aged paper, leather brown, forest green) until Halstuch colors provided; light/dark |
| Hosting | Single VPS (~€5–10/mo), Docker Compose, Caddy HTTPS, off-site backup |

## 3. Data model

All time-ranged entities use the same pattern: optional start/end (year precision allowed) to fit fuzzy 40-year-old records.

- **Person** — name, optional portrait, bio/notes, optional birth year, consent/visibility flag. **Exists with zero photos.**
- **Group** — name (e.g. Sippe Rotmilan), type/Stufe (Meute | Sippe | Rovertrupp | Leiterrunde | Stamm), founded/dissolved year (lifespan; groups appear and go inactive, e.g. Sippe Rotschwanzbussard 2017, inactive).
- **Membership** — Person ↔ Group, von/bis year (both optional), role (Mitglied | Sippenführer | Leiter). Powers "which groups was I in" and "who was in Sippe X in 1988".
- **Attendance** — Person ↔ Event directly (not only via photos), optional role (Teilnehmer | Leiter | Koch …). Powers "who was at Sommerlager 1989" even with no surviving photos.
- **Photo** — original file (never recompressed) + derivatives; **fuzzy/circa date** (exact date | year | decade "~1980er"); caption; place; tags; linked people; linked event; uploader/contributor credit; moderation status (draft/published); consent-derived visibility.
- **Event** — name, date/range, place, **story text (narrative)**, optional EventSeries.
- **EventSeries** — links recurring events (Sommerlager 1985 → 2025).
- **Place** — named recurring locations (Heim Huttenstraße, Zeltplatz, Bodensee), optional GPS.
- **Tag** — free labels, one shared namespace.

Three Person-join relations share one mental model: Membership (↔Group, time-ranged), Attendance (↔Event), photo-people tagging (↔Photo).

## 4. Roles & access

- **Admin** — everything incl. invites, users, hard deletes.
- **Kurator** (curator) — moderation queue, publish, edit all metadata, takedown handling, exports.
- **Mitglied** (member) — browse everything published, upload (→ draft), tag suggestions/comments where enabled.
- **Anonymous** — nothing (auth wall; robots excluded).

Invite flow: admin generates invite link → invitee chooses own display name + password.

Consent/takedown: "Person verbergen" flag hides all photos tagged with that person from non-curators immediately; curator performs hard removal if required. Photos of minors default to member-only visibility (never public).

## 5. Feature scope (tiered)

### MVP — build first, launch, start data entry
- All collections + Payload admin (People, Groups, Memberships, Events, Series, Places, Photos, Attendance, Tags)
- Invite-only auth + 3 roles
- Member upload, mobile-first web: pick photos → optional quick questions (what/year/who) → saved as **draft**
- **Moderation queue** = Payload drafts/publish
- Fuzzy/circa dates on photos + memberships
- Manual people tagging; photo↔event linking
- Browse/filter: Jahr / Gruppe / Ereignis / Ort / Person / Tag; person page (group + event history as time band); event page (story + grid + attendees + series link)
- German UI, Greif theming, light/dark
- Consent flag + takedown path; soft-delete (Papierkorb, 30 days)
- Documented backup (nightly pg_dump + uploads → off-site)

### Phase 2 — before the 2027 Fest
- **Kiosk mode**: fullscreen slideshow, per-image QR → direct download; auto-advance; tablet/beamer
- **Fotobuch export**: pick Event, EventSeries, or **Person** → print-ready PDF (cover, story, captioned photos; person book includes group/event history). Implementation: print-styled Next.js page → headless-Chromium PDF. Curator reorders/excludes before export.
- **Timeline / series scrub** (Sommerlager year-by-year)
- **Face detection** (CompreFace as separate REST container) → tag *suggestions*, human confirms
- **XMP sidecar write** (exiftool hook): tags, people, date, GPS, caption → portable metadata
- Duplicate detection on upload (perceptual hash)
- Map view (geotagged photos + Places)
- Per-photo comments/memories from members

### Later / nice-to-have
- "Who is this?" crowd-ID workflow for unknown faces
- Multi-language beyond German
- Projection slideshow variant for the hall
- "On this day X years ago"

Explicitly out of scope: digitizing hardware/workflow for physical slides (separate problem); public registration; native mobile apps (responsive PWA suffices for invite-only members).

## 6. Architecture & hosting

```
One VPS (e.g. Hetzner) — Docker Compose:
  app: Next.js + Payload (one container)
  db:  Postgres
  (Phase 2: compreface)
Volumes: postgres-data, uploads (originals + derivatives)
Caddy → HTTPS, e.g. archiv.stamm-greif.de
Backup: nightly pg_dump + uploads dir → Hetzner Storage Box / Backblaze B2
```

- Originals stored as uploaded, atomically (temp + move); derivatives (thumbnail, web) generated via sharp/libvips beside them.
- Storage estimate: 10k photos × ~15 MB ≈ 150 GB — VPS + Storage Box, no object-storage complexity.
- Disaster recovery = new server + restore two volumes + `docker compose up`.

## 7. Error handling & data safety

- Upload: max 100 MB/file; accept JPEG, PNG, HEIC, TIFF, WebP; visible retry on failure, never silent drop.
- Nothing member-uploaded is visible until published (moderation).
- Soft-delete with 30-day Papierkorb; hard delete admin-only.
- Consent flag propagates immediately.
- Monitoring: uptime ping + disk-space alert only.

## 8. Testing

- **Unit:** time-range logic (membership overlap, fuzzy-date sorting/filtering) — the trickiest pure logic.
- **Integration:** access control matrix (anonymous/Mitglied/Kurator/Admin × draft/published/hidden-person) — highest-stakes area (minors' photos).
- **E2E:** upload → moderate → publish → visible happy path; invite flow.

## 9. Timeline pressure

App must be usable well before the 2027 Fest: the bottleneck is volunteers entering 40+ years of metadata, not the build. Target: MVP live early enough that tagging runs for months; Phase 2 (kiosk, Fotobuch, timeline) lands before the Fest.

## 10. Org facts informing the design

- Pfadfinderhorst Greif e.V., Bruchsal; PSD (within DPV umbrella); bündisch, interkonfessionell; German-speaking.
- Founded 1977; e.V. 1988. Jubiläum: 50 Jahre → 2027.
- Structure: Stamm → Meute (Wölflinge 6–10) / Sippen (11+) / Rovertrupp / Leiter. Sippen named after raptors (Rotmilan, Wüstenbussard, Weißschwanzbussard); Meute Merlin. Groups have lifespans.
- Recurring: Oster-/Pfingst-/Sommerlager, Fahrten, Gruppenstunden; venues: Heim Huttenstraße, eigener Zeltplatz, Bodensee tours.
