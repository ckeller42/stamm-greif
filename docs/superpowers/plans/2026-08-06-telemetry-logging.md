# Telemetry & Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Structured JSON logging with user-visible error-IDs, an agent query script, a health endpoint, log rotation, Caddy access logs — plus the HEIC upload fix as acceptance demo.

**Architecture:** All logs go to stdout as JSON; Docker json-file driver + rotation is storage; `docker compose logs` is the query API wrapped by `scripts/errors.sh`. Errors funnel through `src/lib/telemetry.ts` (ID + ring buffer) from two catchpoints: Next's `onRequestError` (pages/routes) and Payload's `afterError` config hook (API — contract verified: returns `{response?, status?}`, so the error-ID can be attached to the response body).

**Tech Stack:** Next.js 16 instrumentation, Payload 3.87 hooks (`hooks.afterError`, `logger`), pino (already a Payload dep), Caddy JSON logs, bash+jq.

**Spec:** `docs/superpowers/specs/2026-08-06-telemetry-logging-design.md`

## Global Constraints

- Branch `telemetry` (exists, spec committed on it). Every commit ends with the two trailer lines shown by `git log -1 --format=%B` (Co-Authored-By + Claude-Session).
- Error-ID format: exactly 6 lowercase hex chars (`crypto.randomBytes(3).toString('hex')`).
- `recordError` must never throw; ring buffer capped at 200 entries, window = 1 hour.
- German UI strings live in `src/messages/de.ts` — never hardcode German in components.
- All existing tests must stay green: 23 unit (+ what this plan adds), int suite, 3 e2e journeys.
- `pnpm exec tsc --noEmit` and `pnpm lint` clean after every task.
- Photos allowlist after HEIC fix: `['image/jpeg', 'image/png', 'image/tiff', 'image/webp']`.
- Health endpoint: HTTP 200 with `status: "ok"`, HTTP 503 with `status: "degraded"` when the DB check fails; DB check timeout 2000 ms.

---

### Task 1: Telemetry core + app-wide error catch + Payload JSON logger

**Files:**
- Create: `src/lib/telemetry.ts`
- Create: `instrumentation.ts` (repo root — Next auto-detects it; `src/` variants also work but root is used here)
- Modify: `src/payload.config.ts` (add `logger` option)
- Test: `tests/unit/telemetry.test.ts`

**Interfaces:**
- Produces: `newErrorId(): string` (6 hex), `recordError(e: {errorId: string; msg: string; [k: string]: unknown}): void` (writes one JSON line to stdout via `console.error`, pushes `{errorId, time}` into the ring), `errorsLastHour(): number`. Tasks 2 and 3 import exactly these.

- [ ] **Step 1: Write the failing unit test**

Create `tests/unit/telemetry.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest'
import { newErrorId, recordError, errorsLastHour, _resetRing } from '@/lib/telemetry'

afterEach(() => { _resetRing(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('newErrorId', () => {
  it('is 6 lowercase hex chars and unique-ish', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newErrorId()))
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{6}$/)
    expect(ids.size).toBeGreaterThan(45)
  })
})

describe('recordError / errorsLastHour', () => {
  it('counts recorded errors and emits one JSON line', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    recordError({ errorId: 'abc123', msg: 'kaputt', path: '/x' })
    expect(errorsLastHour()).toBe(1)
    const line = JSON.parse(spy.mock.calls[0][0] as string)
    expect(line).toMatchObject({ level: 'error', errorId: 'abc123', msg: 'kaputt', path: '/x' })
    expect(typeof line.time).toBe('string')
  })

  it('expires entries older than an hour', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.useFakeTimers()
    recordError({ errorId: 'aaaaaa', msg: 'alt' })
    vi.advanceTimersByTime(61 * 60 * 1000)
    recordError({ errorId: 'bbbbbb', msg: 'neu' })
    expect(errorsLastHour()).toBe(1)
  })

  it('never throws, even on unserializable input', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const cyclic: Record<string, unknown> = { errorId: 'cccccc', msg: 'zirkular' }
    cyclic.self = cyclic
    expect(() => recordError(cyclic as never)).not.toThrow()
  })

  it('caps the ring at 200', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    for (let i = 0; i < 250; i++) recordError({ errorId: 'dddddd', msg: String(i) })
    expect(errorsLastHour()).toBe(200)
  })
})
```

- [ ] **Step 2: Run it — must fail** (`pnpm exec vitest run tests/unit/telemetry.test.ts`; expected: cannot resolve `@/lib/telemetry`)

- [ ] **Step 3: Implement `src/lib/telemetry.ts`**

```typescript
import crypto from 'crypto'

// One JSON line per error to stdout/stderr; Docker's json-file driver is the storage and
// `scripts/errors.sh` the query tool. The ring buffer only feeds /api/health's
// errorsLastHour — process-local by design (resets on restart; history lives in the logs).
const RING_MAX = 200
const HOUR_MS = 60 * 60 * 1000
let ring: { time: number }[] = []

export function newErrorId(): string {
  return crypto.randomBytes(3).toString('hex')
}

export function recordError(entry: { errorId: string; msg: string; [k: string]: unknown }): void {
  try {
    const now = Date.now()
    ring = ring.filter((e) => now - e.time < HOUR_MS)
    if (ring.length >= RING_MAX) ring.shift()
    ring.push({ time: now })
    let line: string
    try {
      line = JSON.stringify({ level: 'error', time: new Date(now).toISOString(), ...entry })
    } catch {
      // unserializable context (circular refs etc.) — degrade to the two safe fields
      line = JSON.stringify({ level: 'error', time: new Date(now).toISOString(), errorId: entry.errorId, msg: String(entry.msg) })
    }
    console.error(line)
  } catch {
    // telemetry must never take the app down
  }
}

export function errorsLastHour(): number {
  const now = Date.now()
  ring = ring.filter((e) => now - e.time < HOUR_MS)
  return ring.length
}

/** Test hook only. */
export function _resetRing(): void {
  ring = []
}
```

- [ ] **Step 4: Run the unit test — must pass** (all 5)

- [ ] **Step 5: Create `instrumentation.ts`** (repo root, next to `next.config.ts`):

```typescript
import { newErrorId, recordError } from '@/lib/telemetry'

export function register(): void {
  // nothing to set up — onRequestError below is the hook that matters
}

// Next.js calls this for every unhandled server error (pages, route handlers, server actions).
// Payload API errors are additionally handled (with response mutation) by the afterError hook
// in payload.config.ts; both funnels share recordError, so /api/health counts everything.
export function onRequestError(
  err: unknown,
  request: { path: string; method: string },
  context: { routerKind: string; routePath: string; routeType: string },
): void {
  const e = err instanceof Error ? err : new Error(String(err))
  recordError({
    errorId: newErrorId(),
    msg: e.message,
    stack: e.stack,
    path: request.path,
    method: request.method,
    routeType: context.routeType,
    routePath: context.routePath,
    source: 'onRequestError',
  })
}
```

- [ ] **Step 6: Configure Payload's logger for structured JSON**

In `src/payload.config.ts`, inside the `buildConfig({...})` object add:

```typescript
  // Structured JSON logs to stdout (pino). Without this Payload is near-silent in the
  // standalone container — the motivating incident produced zero log lines.
  logger: { options: { level: 'info' }, destination: process.stdout },
```

- [ ] **Step 7: Verify** — `pnpm exec tsc --noEmit` clean; `pnpm lint` clean; `pnpm test:unit` all green (27 tests: 22 existing + 5 new).

- [ ] **Step 8: Commit** — `feat: telemetry core (error-IDs, ring buffer), app-wide error capture, JSON logger`

---

### Task 2: afterError hook — error-IDs on API responses

**Files:**
- Modify: `src/payload.config.ts` (add `hooks.afterError`)
- Test: `tests/int/telemetry.int.test.ts` (new)

**Interfaces:**
- Consumes: `newErrorId`, `recordError` from Task 1.
- Produces: every Payload REST error response body gains `errors[0].message` suffixed with ` (Fehler-ID: <id>)`. Task 4's frontend helper relies on the message simply being displayable text — no parsing contract.

- [ ] **Step 1: Add the hook to `src/payload.config.ts`** (top-level `hooks` key in `buildConfig`, sibling of `collections`):

```typescript
  hooks: {
    afterError: [
      ({ error, req, result, collection }) => {
        const errorId = newErrorId()
        recordError({
          errorId,
          msg: error.message,
          stack: error.stack,
          path: req?.url ?? undefined,
          user: req?.user?.email ?? undefined,
          collection: collection?.slug,
          source: 'afterError',
        })
        // Attach the ID to the REST error body so forms can show it („Fehler-ID: abc123").
        // AfterErrorResult supports { response } overrides (verified against 3.87 types).
        if (result && Array.isArray((result as { errors?: { message: string }[] }).errors)) {
          const r = result as { errors: { message: string }[] }
          return {
            response: {
              ...r,
              errors: r.errors.map((e, i) =>
                i === 0 ? { ...e, message: `${e.message} (Fehler-ID: ${errorId})` } : e,
              ),
            },
          }
        }
        return undefined
      },
    ],
  },
```

Import `newErrorId, recordError` from `@/lib/telemetry` at the top of the file.

- [ ] **Step 2: Write the int test** — `tests/int/telemetry.int.test.ts`:

```typescript
// Integration: API error responses carry a Fehler-ID (afterError hook), and the health
// endpoint answers. Needs the dev server running against the TEST database — same setup as
// invites.int.test.ts (see its top-of-file comment).
import { describe, it, expect, beforeAll } from 'vitest'
import { getPayload, type Payload } from 'payload'
import config from '@payload-config'

let payload: Payload
let memberEmail: string
const password = 'geheim123'

beforeAll(async () => {
  payload = await getPayload({ config: await config })
  memberEmail = `tele${Date.now()}@example.com`
  await payload.create({
    collection: 'users',
    data: { name: 'Tele Test', email: memberEmail, password, role: 'mitglied' },
    overrideAccess: true,
  })
})

async function loginCookie(): Promise<string> {
  const res = await fetch('http://localhost:3000/api/users/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: memberEmail, password }),
  })
  expect(res.ok).toBe(true)
  return res.headers.get('set-cookie') ?? ''
}

describe('error responses carry a Fehler-ID', () => {
  it('rejected upload (disallowed mime) returns message with Fehler-ID', async () => {
    const cookie = await loginCookie()
    const body = new FormData()
    // a fake HEIC: content is irrelevant, the mime check fires first — this doubles as the
    // regression test for the HEIC allowlist fix (Task 5 removes image/heic from mimeTypes)
    body.append('file', new Blob([new Uint8Array([0, 1, 2, 3])], { type: 'image/heic' }), 'foto.heic')
    body.append('_payload', JSON.stringify({ datePrecision: 'unknown', _status: 'draft' }))
    const res = await fetch('http://localhost:3000/api/photos', {
      method: 'POST', headers: { cookie }, body,
    })
    expect(res.ok).toBe(false)
    const json = (await res.json()) as { errors?: { message: string }[] }
    expect(json.errors?.[0]?.message).toMatch(/Fehler-ID: [0-9a-f]{6}/)
  })
})
```

NOTE for the implementer: this test will only pass its mime-rejection premise after Task 5
removes `image/heic` from the allowlist. Until then the upload fails later (sharp decode) —
which ALSO produces an error response with a Fehler-ID, so the assertion already holds. Run it,
confirm it passes for the right reason after Task 5 lands (the failing message changes from a
decode error to a mime-validation error).

- [ ] **Step 3: Run int suite locally** (start app on test DB as documented in `tests/int/invites.int.test.ts` header; `pnpm test:int`). All existing + new tests green.

- [ ] **Step 4: tsc + lint clean. Commit** — `feat: attach Fehler-IDs to API error responses (afterError hook)`

---

### Task 3: /api/health

**Files:**
- Create: `src/app/api/health/route.ts`
- Test: extend `tests/int/telemetry.int.test.ts`

**Interfaces:**
- Consumes: `errorsLastHour` from Task 1.
- Produces: `GET /api/health` → 200 `{"status":"ok","db":true,"errorsLastHour":n}` or 503 `{"status":"degraded","db":false,"errorsLastHour":n}`.

- [ ] **Step 1: Implement the route**

```typescript
import { getPayload } from 'payload'
import config from '@payload-config'
import { errorsLastHour } from '@/lib/telemetry'

// Liveness + degradation signal for Uptime Kuma (see docs/betrieb.md „Monitoring"): 200 = ok,
// 503 = DB unreachable. Static route — takes precedence over Payload's /api/[...slug] catchall.
export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  let db = false
  try {
    const payload = await getPayload({ config })
    await Promise.race([
      payload.count({ collection: 'users', overrideAccess: true }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('db timeout')), 2000)),
    ])
    db = true
  } catch {
    db = false
  }
  return Response.json(
    { status: db ? 'ok' : 'degraded', db, errorsLastHour: errorsLastHour() },
    { status: db ? 200 : 503 },
  )
}
```

- [ ] **Step 2: Extend the int test** (same file, new describe):

```typescript
describe('health endpoint', () => {
  it('answers 200 ok with error count', async () => {
    const res = await fetch('http://localhost:3000/api/health')
    expect(res.status).toBe(200)
    const json = (await res.json()) as { status: string; db: boolean; errorsLastHour: number }
    expect(json.status).toBe('ok')
    expect(json.db).toBe(true)
    expect(typeof json.errorsLastHour).toBe('number')
  })
})
```

- [ ] **Step 3: Run int suite; tsc+lint; commit** — `feat: /api/health endpoint (db check + error count) for uptime monitoring`

---

### Task 4: Frontend — show server error messages (incl. Fehler-ID)

**Files:**
- Modify: `src/app/(frontend)/hochladen/UploadForm.tsx`
- Modify: `src/messages/de.ts`
- Create: `src/lib/server-error.ts`

**Interfaces:**
- Consumes: error responses shaped `{errors:[{message}]}` (Task 2 suffixes the first message with the Fehler-ID).
- Produces: `formatServerError(body: unknown): string | null` — first error message or null.

- [ ] **Step 1: `src/lib/server-error.ts`**

```typescript
// Extracts the first human-readable error message from a Payload REST error body
// ({ errors: [{ message }] }); afterError has already suffixed it with the Fehler-ID.
export function formatServerError(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null
  const errors = (body as { errors?: unknown }).errors
  if (!Array.isArray(errors) || errors.length === 0) return null
  const message = (errors[0] as { message?: unknown }).message
  return typeof message === 'string' && message.length > 0 ? message : null
}
```

- [ ] **Step 2: Surface it in `UploadForm.tsx`**

Change `uploadOne` to capture the message, store it in the file state, and render it:

- `FileState` gains `serverError?: string`.
- In `uploadOne`'s `!res.ok` path: `const msg = formatServerError(await res.json().catch(() => null))`; return it alongside the status (change return type to `{ status: 'fertig' | 'fehler'; serverError?: string }` and adjust the caller).
- In the render list: `{f.file.name} — {statusLabels[f.status]}{f.serverError ? ` — ${f.serverError}` : ''}`.
- The generic `de.upload.error` line stays as the summary; per-file lines now carry the specific reason + Fehler-ID.

- [ ] **Step 3: Add a unit test** for `formatServerError` in `tests/unit/server-error.test.ts`: valid body → message; `{}`/`null`/`{errors:[]}`/`{errors:[{}]}` → null. (4 assertions, straightforward — write them out.)

- [ ] **Step 4: unit suite green; tsc+lint; `pnpm test:e2e` (dev path) still 3 passed — the success path renders unchanged. Commit** — `feat: surface server error messages incl. Fehler-ID in upload form`

---

### Task 5: HEIC fix — allowlist, accept attribute, hint

**Files:**
- Modify: `src/collections/Photos.ts` (mimeTypes)
- Modify: `src/app/(frontend)/hochladen/UploadForm.tsx` (accept attr)
- Modify: `src/messages/de.ts` (hint string)

- [ ] **Step 1: `Photos.ts`** — change `mimeTypes` to exactly `['image/jpeg', 'image/png', 'image/tiff', 'image/webp']` with comment:

```typescript
    // image/heic|heif deliberately absent: the bundled sharp/libvips cannot decode HEIC
    // (patent-encumbered codec, "Support for this compression format has not been built in").
    // iPhones convert HEIC→JPEG client-side when the file input's accept lists concrete types
    // (see UploadForm). Re-adding HEIC requires a libheif-enabled sharp build — tracked follow-up.
```

- [ ] **Step 2: `UploadForm.tsx`** — file input `accept="image/jpeg,image/png,image/tiff,image/webp"` (replaces `image/*`; this is what makes iOS transcode HEIC in the picker), and render the new hint under the input: add to `de.ts` `upload:` block: `formats: 'JPEG, PNG, TIFF oder WebP — iPhone-Fotos werden beim Auswählen automatisch konvertiert.'` and render `<p style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>{de.upload.formats}</p>`.

- [ ] **Step 3: Re-run the Task 2 int test — the upload-rejection test must now fail at mime validation** (assert message still matches `Fehler-ID`; manually confirm in output that the message is now the mime error, not a decode error). Full int suite + e2e green; tsc+lint. **Commit** — `fix: reject HEIC uploads clearly; concrete accept list makes iPhones transcode`

---

### Task 6: Access logs, rotation, errors.sh, ops doc

**Files:**
- Modify: `Caddyfile`, `Caddyfile.localhost`
- Modify: `docker-compose.yml`
- Create: `scripts/errors.sh`
- Modify: `docs/betrieb.md`

- [ ] **Step 1: Caddy access logs** — inside the site block of BOTH Caddyfiles add:

```
	log {
		output stdout
		format json
	}
```

- [ ] **Step 2: compose log rotation** — add to `app`, `db`, and `caddy` services in `docker-compose.yml`:

```yaml
    logging:
      driver: json-file
      options: { max-size: '10m', max-file: '5' }
```

- [ ] **Step 3: `scripts/errors.sh`** (executable):

```bash
#!/usr/bin/env bash
# Query the app's structured error logs. Run from the repo directory on the server.
#   scripts/errors.sh recent [hours]   errors of the last N hours (default 24)
#   scripts/errors.sh <fehler-id>      every log line for one Fehler-ID
#   scripts/errors.sh tail             follow error output live
# Requires jq (apt/apk install jq). Log storage: Docker json-file driver with rotation
# (docker-compose.yml), so history is bounded but survives restarts.
set -euo pipefail
cd "$(dirname "$0")/.."
cmd="${1:-recent}"
case "$cmd" in
  recent)
    hours="${2:-24}"
    docker compose logs app --no-log-prefix --since "${hours}h" 2>/dev/null \
      | grep -E '"level":"error"|"level":50' \
      | jq -r '[.time, .errorId // "-", .msg, (.path // .url // "-")] | @tsv' 2>/dev/null \
      || echo "keine Fehler in den letzten ${hours}h"
    ;;
  tail)
    docker compose logs app --no-log-prefix -f 2>/dev/null | grep --line-buffered -E '"level":"error"|"level":50'
    ;;
  *)
    # treat as Fehler-ID
    docker compose logs app --no-log-prefix 2>/dev/null | grep -F "\"errorId\":\"$cmd\"" | jq . 2>/dev/null \
      || { echo "Fehler-ID $cmd nicht gefunden (Log evtl. rotiert)"; exit 1; }
    ;;
esac
```

Run `shellcheck scripts/errors.sh` — must be clean (hygiene job enforces it).

- [ ] **Step 4: betrieb.md „Fehlersuche" section** (before „Monitoring"), German, covering: error flow (user sees „Fehler-ID: abc123" → `scripts/errors.sh abc123`), `recent`/`tail` usage, jq prerequisite, `/api/health` semantics (200 ok / 503 degraded) and pointing the existing Kuma paragraph at `https://archiv.stamm-greif.de/api/health` instead of `/anmelden`. Update that Monitoring paragraph accordingly.

- [ ] **Step 5: Validate** — `docker compose config >/dev/null` (rotation YAML valid), Caddyfile syntax via `docker run --rm -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile` (repeat for Caddyfile.localhost), shellcheck clean. **Commit** — `feat: Caddy access logs, log rotation, errors.sh query script, Fehlersuche doc`

---

### Task 7: Ship — PR, CI, review, merge (user gate), redeploy + acceptance demo

- [ ] **Step 1:** Full local gate: `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm test:unit`, int suite (with app server on test DB), `pnpm exec playwright test --workers=1`.
- [ ] **Step 2:** Push `telemetry`, open PR (base main) summarizing spec + incident; CI must go green (test, e2e, docker, hygiene). Address CodeRabbit; resolve all threads.
- [ ] **Step 3:** **USER GATE** — ask before merging.
- [ ] **Step 4:** After merge: on main, redeploy the local/Tailscale stack (`docker compose -f docker-compose.yml -f docker-compose.local.yml -f docker-compose.tailscale.yml up -d --build` after `docker compose build`), run migrations no-op, smoke 200.
- [ ] **Step 5:** **Acceptance demo:** POST the `/tmp/test.heic` fixture as an authenticated request → expect a clear mime-rejection message with Fehler-ID in the response; `scripts/errors.sh <id>` must return the full context; `curl /api/health` → 200 ok with errorsLastHour ≥ 1. Report the demo transcript.

---

## Self-review (done at write time)

- Spec coverage: every spec table row maps to a task (telemetry core+instrumentation+logger → T1, afterError → T2, health → T3, user surface → T4, HEIC → T5, Caddy/rotation/errors.sh/doc → T6, rollout+demo → T7).
- No placeholders; all code complete; the one behavioral dependency (T2's test passing "for the right reason" only after T5) is called out explicitly in both tasks.
- Interface consistency: `newErrorId/recordError/errorsLastHour` names match across T1/T2/T3; error-body shape `{errors:[{message}]}` consistent across T2/T4.
