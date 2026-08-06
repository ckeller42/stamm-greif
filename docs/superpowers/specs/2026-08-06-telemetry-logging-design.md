# Telemetry & Logging — Design

**Date:** 2026-08-06
**Status:** Approved (approach A; user: self-hosted light, error-ID + query script, health endpoint + Kuma, HEIC fix rides along)
**Motivating incident:** An iPhone photo upload failed with a generic „Hochladen fehlgeschlagen".
Root cause (diagnosed live): the Photos mime allowlist accepts `image/heic`, but the bundled
sharp/libvips cannot decode HEIC (`heif: Support for this compression format has not been built
in`) — thumbnail generation threw, the API returned 500, and **no component logged anything**:
Payload's logger is effectively silent, Caddy has no access log, Next standalone prints only
startup lines. An agent had nothing to grep.

## Goals

1. Every server error produces one structured JSON log line with full context and a short
   **error-ID**; API error responses carry that ID; users see it („Fehler abc123").
2. An agent/operator resolves a reported error-ID (or "what broke recently?") with one script.
3. `/api/health` reports app+DB status and recent-error count; Uptime Kuma alerts on non-200.
4. Logs persist across restarts, bounded by rotation, with zero in-container file management.
5. The HEIC failure mode becomes a clear, immediate user message — and serves as the acceptance
   demo of the whole loop.

**Non-goals:** external services (Sentry etc.), metrics/tracing stacks, log shipping,
alerting beyond the health endpoint. **Follow-up (explicitly requested, separate project):**
real HEIC support — build sharp against a libvips with libheif in the Dockerfile, re-add
`image/heic`/`image/heif` to the allowlist, verify with a real `.heic` fixture.

## Architecture

All logging goes to **stdout as JSON** (pino-style fields; `level`, `time`, `msg`, plus context);
Docker's `json-file` driver with rotation is the storage; `docker compose logs` is the query API.

| Piece | File | What it does |
|---|---|---|
| Error core | `src/lib/telemetry.ts` | `newErrorId()` (6 hex chars, `crypto.randomBytes`), `recordError(entry)` → one JSON line to stdout + in-memory ring buffer (last hour, capped 200) for the health endpoint, `errorsLastHour()` |
| App-wide catch | `instrumentation.ts` | Next `onRequestError(err, request, context)` → `recordError` with path/method/routeType/stack + fresh error-ID. Catches page-render and route errors that Payload hooks never see |
| API error-ID | `payload.config.ts` `hooks.afterError` | On any Payload API error: `recordError`, and attach the ID to the response payload so the client can display it. (Exact response-mutation mechanism per Payload 3.87's afterError contract — verified during implementation; fallback: log-only + generic ID-less message, spec's goal 1 degrades gracefully for this surface) |
| Payload logger | `payload.config.ts` `logger` | pino at `info`, JSON to stdout (no pretty transport in the container) |
| User surface | `UploadForm.tsx` (+ `de.ts`) | On failed upload, show the server's error message incl. error-ID instead of the generic text; helper `formatServerError(body)` reusable by other forms |
| Access log | `Caddyfile`, `Caddyfile.localhost` | `log { output stdout / format json }` in the site block — method/path/status/duration for every request |
| Rotation | `docker-compose.yml` | `logging: {driver: json-file, options: {max-size: "10m", max-file: "5"}}` on app, caddy, db |
| Query script | `scripts/errors.sh` | `errors.sh recent [hours]` (error-level lines, jq-formatted), `errors.sh <id>` (all lines for one error-ID), `errors.sh tail` (follow). Wraps `docker compose logs`; requires `jq` (documented) |
| Health | `src/app/api/health/route.ts` | `GET /api/health` → `{status, db, errorsLastHour}`; DB check = fast count with timeout; 200 when ok, 503 when DB down (degraded). Static route wins over Payload's `/api/[...slug]` catchall |
| HEIC fix | `Photos.ts`, `UploadForm.tsx`, `de.ts` | Remove `image/heic`/`image/heif` from `mimeTypes`; set the file input's `accept` to the concrete allowlist (iOS then auto-converts HEIC→JPEG in the picker); German hint listing accepted formats |
| Ops doc | `docs/betrieb.md` | „Fehlersuche" section: errors.sh usage, error-ID flow, health endpoint + Kuma wiring, jq prerequisite |

## Error flow (the incident, replayed after this ships)

1. Phone uploads `.heic` → **client**: file input's `accept` makes iOS convert to JPEG (fix
   usually prevents the error entirely).
2. If a HEIC still reaches the server (desktop, „Keep Originals"): Payload rejects it by mime →
   `afterError` logs `{errorId, msg, path, user, filename, mimeType}` → response carries the ID →
   form shows „Nur JPEG/PNG/WebP/TIFF … (Fehler abc123)".
3. User reports „abc123" → agent runs `scripts/errors.sh abc123` → full context in seconds.
4. Meanwhile `/api/health` still says `ok` (errors counted, DB fine) — Kuma stays quiet unless
   the app is actually down.

## Error handling of the telemetry itself

- `recordError` never throws (try/catch around serialization; ring buffer bounded).
- Health endpoint must not take the app down: DB check timeout ~2 s, always answers.
- Ring buffer is process-local and resets on restart — acceptable (health reflects the running
  process; history lives in the logs).

## Testing

- Unit: `newErrorId` shape/uniqueness; ring-buffer windowing of `errorsLastHour`.
- Int: `GET /api/health` → 200 + shape; a forced Payload API error response carries an error-ID
  (upload with disallowed mime as authenticated member — doubles as the HEIC regression test).
- E2E: existing three journeys must stay green (upload form change is display-only on the
  success path).
- Acceptance demo (manual, post-merge): repeat the HEIC upload against the running stack;
  observe clear message + ID, resolve it via `errors.sh`.

## Rollout

One PR (branch `telemetry`); required checks unchanged (`test`, `e2e`, `docker`); after merge,
redeploy the local/Tailscale stack and run the acceptance demo.
