# CI Pipeline Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close all ten CI pipeline gaps: verify the Docker artifact in CI, publish GHCR images on main, fail PRs on schema drift, add timeouts/caching/coverage/hygiene, and run e2e (three journeys) against the production standalone build.

**Architecture:** Four pieces split by trigger semantics — a composite setup action (dedupe), the PR-gate `ci.yml` (required checks `test`, `e2e`, `docker` + advisory `hygiene`), a `release.yml` publishing to GHCR on main pushes, and `dependabot.yml`. The bare `build` job is removed (the `docker` job runs `next build` inside the image).

**Tech Stack:** GitHub Actions, pnpm 11.18.0 / Node 22, Payload 3.87 (`migrate:create --skip-empty` — verified working on this version), Playwright 1.58, Docker Compose v2, GHCR.

**Spec:** `docs/superpowers/specs/2026-08-05-ci-pipeline-hardening-design.md`

## Global Constraints

- pnpm pinned to **11.18.0**, Node **22** — everywhere, via the composite action only.
- Required checks after this work: exactly `test`, `e2e`, `docker` (branch protection updated post-merge, Task 10).
- `hygiene` job must NOT be a required check.
- All jobs carry `timeout-minutes` (test 15, e2e 20, docker 15, hygiene 10, release 20).
- Coverage is report-only — no thresholds anywhere.
- German UI strings live in `src/messages/de.ts`; e2e asserts on those exact strings.
- All commits end with the standard Co-Authored-By/Claude-Session trailer used throughout this repo (see git log).
- Work happens on branch `ci-hardening` off current `main` (which already contains the spec commit `f7ab3c9`).

---

### Task 1: Composite setup action + ci.yml dedupe + timeouts

**Files:**
- Create: `.github/actions/setup/action.yml`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: local composite action `./.github/actions/setup` (no inputs, no outputs) — every later job step-list starts with `- uses: actions/checkout@v4` then `- uses: ./.github/actions/setup`.

- [ ] **Step 1: Create branch**

```bash
cd /Users/ckeller/src/stamm-greif && git checkout -b ci-hardening main
```

- [ ] **Step 2: Write the composite action**

Create `.github/actions/setup/action.yml`:

```yaml
name: Setup pnpm + Node + deps
description: corepack-pinned pnpm 11.18.0, Node 22 with pnpm cache, frozen-lockfile install
runs:
  using: composite
  steps:
    - name: Enable corepack / pin pnpm
      shell: bash
      run: |
        corepack enable
        corepack prepare pnpm@11.18.0 --activate
    - uses: actions/setup-node@v4
      with:
        node-version: 22
        cache: pnpm
    - name: Install dependencies
      shell: bash
      run: pnpm install --frozen-lockfile
```

- [ ] **Step 3: Refactor ci.yml to use it and add timeouts**

In `.github/workflows/ci.yml`, for each of the three jobs (`test`, `e2e`, `build`): replace the four setup steps (`Enable corepack / pin pnpm`, `actions/setup-node@v4`, `pnpm install --frozen-lockfile` — keep `actions/checkout@v4`) with the single step:

```yaml
      - uses: ./.github/actions/setup
```

Add `timeout-minutes` to each job declaration:

```yaml
  test:
    name: test
    runs-on: ubuntu-latest
    timeout-minutes: 15
```

(`e2e`: 20, `build`: 10 — build is deleted in Task 6 but keep it green until then.)

- [ ] **Step 4: Validate YAML locally**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml')); yaml.safe_load(open('.github/actions/setup/action.yml')); print('YAML OK')"
```

Expected: `YAML OK`

- [ ] **Step 5: Commit**

```bash
git add .github/actions/setup/action.yml .github/workflows/ci.yml
git commit -m "ci: extract shared setup into composite action, add job timeouts"
```

---

### Task 2: Test job — migration drift check + coverage

**Files:**
- Modify: `.github/workflows/ci.yml` (test job)
- Modify: `package.json` (add devDep `@vitest/coverage-v8`, coverage flag)

**Interfaces:**
- Consumes: composite action from Task 1.
- Produces: `pnpm test:unit` now emits a v8 coverage summary; CI test job fails on schema drift with the message `Schema drift: run pnpm payload migrate:create and commit the result`.

- [ ] **Step 1: Add the coverage provider**

```bash
pnpm add -D @vitest/coverage-v8
```

- [ ] **Step 2: Add coverage to the unit script**

In `package.json`, change:

```json
"test:unit": "vitest run tests/unit",
```

to:

```json
"test:unit": "vitest run tests/unit --coverage.enabled --coverage.include='src/lib/**'",
```

(Scope to `src/lib/**` — the pure-logic units that unit tests actually target; whole-src coverage of collections/pages from unit tests alone would be noise.)

- [ ] **Step 3: Run unit tests locally, verify coverage table renders**

```bash
pnpm test:unit
```

Expected: 22 tests pass, followed by a `% Coverage report from v8` table listing `src/lib` files.

- [ ] **Step 4: Add the drift-check step to the test job**

In `.github/workflows/ci.yml` `test` job, insert after the `Typecheck` step and before `Unit tests`. Mechanism verified on Payload 3.87: with `--skip-empty`, `migrate:create` writes NO file when collections match the applied migrations, and writes one when they don't — so a file-count delta is the drift signal. It diffs against the migrated database, hence this runs after the test DB is up (it is — the job starts it earlier) using the TEST database:

```yaml
      - name: Migration drift check
        env:
          DATABASE_URI: postgres://archiv:archiv@localhost:5433/archiv_test
        run: |
          docker compose -f docker-compose.dev.yml exec -T db-test psql -U archiv -d archiv_test \
            -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" >/dev/null
          pnpm payload migrate
          before=$(ls src/migrations/*.ts | wc -l)
          pnpm payload migrate:create ci_drift_check --skip-empty
          after=$(ls src/migrations/*.ts | wc -l)
          if [ "$after" -ne "$before" ]; then
            echo "::error::Schema drift: run pnpm payload migrate:create and commit the result"
            git status --porcelain src/migrations/
            exit 1
          fi
          echo "no drift"
```

Note: wiping the schema first makes the check deterministic (applies exactly the committed migrations, nothing inherited from earlier steps). The integration tests run AFTER this step and re-use that freshly-migrated DB — that is fine, they create their own rows. But the int-test app server (started in a later step) must still be started after this wipe, which it is in the current step order: drift check runs before `Start app for integration tests`. Verify that ordering when editing.

- [ ] **Step 5: Verify the drift check logic locally (positive + negative)**

```bash
# negative (no drift) — against dev DB:
docker compose -f docker-compose.dev.yml up -d db
before=$(ls src/migrations/*.ts | wc -l); pnpm payload migrate:create local_probe --skip-empty; after=$(ls src/migrations/*.ts | wc -l); [ "$after" -eq "$before" ] && echo "PASS: no drift detected"
```

Expected: `PASS: no drift detected`.

```bash
# positive (drift) — add a throwaway field, expect a file:
# in src/collections/Places.ts add to fields:  { name: 'driftProbe', type: 'text' },
before=$(ls src/migrations/*.ts | wc -l); pnpm payload migrate:create local_probe --skip-empty; after=$(ls src/migrations/*.ts | wc -l); [ "$after" -gt "$before" ] && echo "PASS: drift detected"
# then: revert Places.ts AND delete the generated src/migrations/*local_probe* files (.ts and .json) AND restore src/migrations/index.ts (git checkout src/migrations/)
git checkout src/collections/Places.ts src/migrations/ && git clean -f src/migrations/
```

Expected: `PASS: drift detected`, then clean `git status`.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml .github/workflows/ci.yml
git commit -m "ci: fail PRs on migration drift; report unit coverage"
```

---

### Task 3: E2E against the production standalone build

**Files:**
- Create: `scripts/start-standalone.sh`
- Modify: `playwright.config.ts`
- Modify: `.github/workflows/ci.yml` (e2e job: browser cache)

**Interfaces:**
- Produces: `scripts/start-standalone.sh` — builds nothing; copies static assets into `.next/standalone` and execs `node .next/standalone/server.js`. Playwright CI webServer = `pnpm build && bash scripts/start-standalone.sh`.

- [ ] **Step 1: Write the standalone start script**

Create `scripts/start-standalone.sh`:

```bash
#!/usr/bin/env bash
# Serve the production standalone build exactly the way the Dockerfile does: the traced server
# bundle needs .next/static and public/ copied inside it (next start does NOT serve
# output:'standalone' builds — it silently falls back to the regular server).
# Used by Playwright's CI webServer (playwright.config.ts). Run `pnpm build` first.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -d .next/standalone ] || { echo "no .next/standalone — run pnpm build first" >&2; exit 1; }
cp -r .next/static .next/standalone/.next/static
cp -r public .next/standalone/public
exec node .next/standalone/server.js
```

```bash
chmod +x scripts/start-standalone.sh
```

- [ ] **Step 2: Switch Playwright's CI webServer to it**

In `playwright.config.ts`, replace the `webServer` block:

```typescript
  webServer: {
    // CI runs the real production artifact (standalone build) to kill dev/prod skew; locally
    // keep next dev + reuse for fast iteration. reuseExistingServer stays off in CI so a stale
    // server from another step can never answer against the wrong database.
    command: process.env.CI ? 'pnpm build && bash scripts/start-standalone.sh' : 'pnpm dev',
    reuseExistingServer: !process.env.CI,
    url: 'http://localhost:3000',
    timeout: 240_000,
  },
```

(`timeout: 240_000` — the CI command now includes a full `next build`, which exceeds Playwright's 60 s default server timeout.)

- [ ] **Step 3: Verify the standalone path locally**

```bash
docker compose -f docker-compose.dev.yml up -d db && sleep 3
PAYLOAD_SECRET=build-time-placeholder-not-used-at-runtime pnpm build
(DATABASE_URI=postgres://archiv:archiv@localhost:5432/archiv PAYLOAD_SECRET=$(grep '^PAYLOAD_SECRET=' .env | cut -d= -f2-) bash scripts/start-standalone.sh &) && sleep 5
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/anmelden
lsof -t -i:3000 | xargs -r kill -9
```

Expected: `200`.

- [ ] **Step 4: Add the Playwright browser cache to the e2e job**

In `.github/workflows/ci.yml` `e2e` job, insert directly BEFORE the `Install Playwright browser` step:

```yaml
      - name: Cache Playwright browser
        uses: actions/cache@v4
        with:
          path: ~/.cache/ms-playwright
          key: playwright-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml') }}
```

And change the install step so system deps are still present on cache hits (browser binaries cache; apt packages don't):

```yaml
      - name: Install Playwright browser
        run: pnpm exec playwright install --with-deps chromium
```

(unchanged command — the cache just makes the download portion a no-op.)

- [ ] **Step 5: Run existing e2e locally to prove no regression (dev-server path)**

```bash
pnpm test:e2e
```

Expected: `1 passed`.

- [ ] **Step 6: Commit**

```bash
git add scripts/start-standalone.sh playwright.config.ts .github/workflows/ci.yml
git commit -m "ci: run e2e against production standalone build; cache Playwright browser"
```

---

### Task 4: E2E seeds + invite journey

**Files:**
- Modify: `tests/e2e/global-setup.ts`
- Create: `tests/e2e/invite.spec.ts`

**Interfaces:**
- Consumes: `.seed.json` written by global-setup (existing fields: `email`, `password`, `personId`, `eventId`, `caption`, `photoId`).
- Produces: `.seed.json` gains `inviteToken` (string), `memberB: {email, password}`, `kurator: {email, password}`. Later specs read exactly these names.

- [ ] **Step 1: Extend the global setup seeds**

In `tests/e2e/global-setup.ts`, inside `globalSetup()` after the existing user creation, add:

```typescript
  // Second member + kurator for the upload/moderation journey; unused invite for the invite
  // journey. Same unique-per-run discipline as the rest of the seeds.
  const memberB = { email: `e2e-b-${stamp}@example.com`, password }
  await payload.create({
    collection: 'users',
    data: { name: 'E2E Mitglied B', email: memberB.email, password, role: 'mitglied' },
    overrideAccess: true,
  })
  const kurator = { email: `e2e-k-${stamp}@example.com`, password }
  await payload.create({
    collection: 'users',
    data: { name: 'E2E Kurator', email: kurator.email, password, role: 'kurator' },
    overrideAccess: true,
  })
  const invite = await payload.create({
    collection: 'invites',
    // token has a runtime defaultValue (crypto.randomUUID) but the generated type marks it
    // required for create() input — same cast the int tests use.
    data: { role: 'mitglied' } as never,
    overrideAccess: true,
  })
```

And extend the `writeFileSync` object with:

```typescript
      { email, password, personId: person.id, eventId: event.id, caption, photoId: photo.id,
        inviteToken: invite.token, memberB, kurator },
```

- [ ] **Step 2: Write the invite journey spec**

Create `tests/e2e/invite.spec.ts`:

```typescript
// E2E: the unauthenticated invite-accept journey — the user-visible contract of the invites
// system, including the single-use behaviour the TOCTOU fix enforces server-side.
import { test, expect } from '@playwright/test'
import { readFileSync } from 'fs'
import { SEED_FILE } from './global-setup'

const seed = JSON.parse(readFileSync(SEED_FILE, 'utf8')) as {
  inviteToken: string
}

test('invite: accept creates account, auto-logs-in, and the link is single-use', async ({ page }) => {
  const email = `e2e-invitee-${Date.now()}@example.com`

  // 1. Open the invite link, create the account.
  await page.goto(`/einladung/${seed.inviteToken}`)
  await expect(page.getByRole('heading', { name: 'Willkommen beim Stamm-Greif-Archiv' })).toBeVisible()
  await page.getByLabel('Dein Name').fill('E2E Invitee')
  await page.getByLabel('E-Mail').fill(email)
  await page.getByLabel('Passwort').fill('geheim123')
  await page.getByRole('button', { name: 'Konto erstellen' }).click()

  // 2. Accept auto-logs-in and lands on the archive.
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('heading', { name: 'Archiv', level: 1 })).toBeVisible()

  // 3. The invite is used up: a second accept attempt shows the invalid-invite message.
  await page.goto(`/einladung/${seed.inviteToken}`)
  await page.getByLabel('Dein Name').fill('Second Try')
  await page.getByLabel('E-Mail').fill(`e2e-second-${Date.now()}@example.com`)
  await page.getByLabel('Passwort').fill('geheim123')
  await page.getByRole('button', { name: 'Konto erstellen' }).click()
  await expect(page.getByRole('alert')).toContainText('Einladung')
})
```

Note on the final assertion: `de.invite.invalid` is the invalid-invite message rendered in a `role="alert"` paragraph. Check `src/messages/de.ts` line ~5-7 for the exact string; `toContainText('Einladung')` matches it without hardcoding the full sentence. If `de.invite.invalid` does not contain the word "Einladung", use the actual string from `de.ts` instead.

- [ ] **Step 3: Run it locally**

```bash
docker compose -f docker-compose.dev.yml up -d db && pnpm test:e2e
```

Expected: `2 passed` (happy path + invite).

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/global-setup.ts tests/e2e/invite.spec.ts
git commit -m "test: e2e invite-accept journey incl. single-use contract"
```

---

### Task 5: E2E upload/moderation journey

**Files:**
- Create: `tests/e2e/upload-moderation.spec.ts`

**Interfaces:**
- Consumes: `.seed.json` fields `email`/`password` (member A), `memberB: {email, password}`, `kurator: {email, password}` from Task 4. Upload fixture: `tests/fixtures/dia.jpg` (exists). UI strings from `src/messages/de.ts`: upload page heading `Fotos hochladen`, submit button `Hochladen`, success text `de.upload.success`.

- [ ] **Step 1: Write the journey spec**

Create `tests/e2e/upload-moderation.spec.ts`:

```typescript
// E2E: member upload → draft is private → kurator publishes (REST, as the admin UI is out of
// e2e scope) → photo visible to other members. Covers the moderation pipeline end-to-end.
import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { SEED_FILE } from './global-setup'

const seed = JSON.parse(readFileSync(SEED_FILE, 'utf8')) as {
  email: string; password: string
  memberB: { email: string; password: string }
  kurator: { email: string; password: string }
}
const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'dia.jpg')

async function login(page: Page, email: string, password: string) {
  await page.goto('/anmelden')
  await page.getByLabel('E-Mail').fill(email)
  await page.getByLabel('Passwort').fill(password)
  await page.getByRole('button', { name: 'Anmelden' }).click()
  await expect(page).toHaveURL(/\/$/)
}

test('upload → moderation → visibility', async ({ page, browser }) => {
  const caption = `E2E Moderation ${Date.now()}`

  // 1. Member A uploads a photo (lands as draft — members cannot self-publish).
  await login(page, seed.email, seed.password)
  await page.goto('/hochladen')
  await expect(page.getByRole('heading', { name: 'Fotos hochladen' })).toBeVisible()
  await page.locator('input[type="file"]').setInputFiles(fixture)
  await page.getByLabel(/Beschreibung/).fill(caption)
  await page.getByRole('button', { name: 'Hochladen' }).click()
  await expect(page.getByText('dia.jpg — fertig')).toBeVisible()

  // 2. Member B does not see the draft in the archive.
  const ctxB = await browser.newContext()
  const pageB = await ctxB.newPage()
  await login(pageB, seed.memberB.email, seed.memberB.password)
  await expect(pageB.getByRole('heading', { name: 'Archiv', level: 1 })).toBeVisible()
  await expect(pageB.getByText(caption)).toHaveCount(0)

  // 3. Kurator publishes the draft via the REST API (request context, own session).
  const kuratorCtx = await browser.newContext()
  const loginRes = await kuratorCtx.request.post('/api/users/login', {
    data: { email: seed.kurator.email, password: seed.kurator.password },
  })
  expect(loginRes.ok()).toBeTruthy()
  const found = await kuratorCtx.request.get(
    `/api/photos?draft=true&where[caption][equals]=${encodeURIComponent(caption)}`,
  )
  expect(found.ok()).toBeTruthy()
  const photoId = (await found.json()).docs[0]?.id
  expect(photoId).toBeTruthy()
  const publish = await kuratorCtx.request.patch(`/api/photos/${photoId}?draft=true`, {
    data: { _status: 'published' },
  })
  expect(publish.ok()).toBeTruthy()

  // 4. Member B now sees the photo.
  await pageB.reload()
  await expect(pageB.getByText(caption)).toBeVisible()

  await ctxB.close()
  await kuratorCtx.close()
})
```

Implementation notes for the engineer:
- `baseURL` applies to `request` contexts created from `browser.newContext()` in this config, so relative API paths work.
- The draft query needs `draft=true` to surface unpublished versions to the kurator; without it the find returns only published docs. If `where[caption][equals]` returns nothing despite the upload succeeding, debug with `console.log(await found.json())` — the likely cause is the version-vs-parent caption living under `version.caption` in `_photos_v`; in that case query `/api/photos?draft=true&where[caption][like]=E2E%20Moderation` and pick `docs[0]`.
- Step 1's `dia.jpg — fertig` assertion matches the upload list-item format in `UploadForm.tsx` (`{f.file.name} — {statusLabels[f.status]}`, status label `de.upload.status.fertig`). Check `de.ts` for the exact `fertig` label text and adjust if it isn't literally "fertig".

- [ ] **Step 2: Run locally**

```bash
pnpm test:e2e
```

Expected: `3 passed`. If the moderation test flakes on the publish step, apply the debug note above before touching anything else.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/upload-moderation.spec.ts
git commit -m "test: e2e upload/moderation journey (draft privacy, kurator publish)"
```

---

### Task 6: Docker job (replaces `build`)

**Files:**
- Modify: `.github/workflows/ci.yml` (delete `build` job, add `docker` job)

**Interfaces:**
- Produces: required-check name `docker`. Consumes nothing from other jobs.

- [ ] **Step 1: Delete the `build` job**

Remove the entire `build:` job block from `.github/workflows/ci.yml` (its `next build` is subsumed by the image build below).

- [ ] **Step 2: Add the `docker` job**

```yaml
  # Builds the production image and boots the full compose stack (app + db + caddy via the
  # localhost override), then smoke-tests through Caddy. This is the only place CI verifies the
  # actual deployment artifact: Dockerfile stages, USER node, /app/photos ownership, compose
  # wiring, migrations-in-stack.
  docker:
    name: docker
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4

      - name: Create throwaway env
        run: |
          {
            echo "DB_PASSWORD=$(openssl rand -hex 16)"
            echo "PAYLOAD_SECRET=$(openssl rand -hex 32)"
          } > .env

      - name: Build images
        run: docker compose build

      - name: Boot stack and migrate
        run: |
          docker compose -f docker-compose.yml -f docker-compose.local.yml up -d db
          docker compose run --rm migrate
          docker compose -f docker-compose.yml -f docker-compose.local.yml up -d

      - name: Smoke test through Caddy
        run: |
          for i in $(seq 1 30); do
            code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 http://127.0.0.1/anmelden || true)
            [ "$code" = "200" ] && { echo "smoke OK"; exit 0; }
            sleep 3
          done
          echo "::error::stack never served /anmelden with 200 (last code: $code)"
          docker compose logs
          exit 1

      - name: Teardown
        if: always()
        run: docker compose -f docker-compose.yml -f docker-compose.local.yml down -v
```

- [ ] **Step 3: Validate + local dry run**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml')); print('YAML OK')"
# local proof (identical commands, throwaway env in a temp copy is unnecessary — reuse local .env):
docker compose build 2>&1 | tail -2
```

Expected: `YAML OK`; compose build succeeds.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: verify Docker artifact (build + stack boot + Caddy smoke); drop bare build job"
```

---

### Task 7: Hygiene job + shellcheck fixes

**Files:**
- Modify: `.github/workflows/ci.yml` (add `hygiene` job)
- Possibly modify: `scripts/backup.sh`, `scripts/start-standalone.sh` (whatever shellcheck flags)

**Interfaces:** none consumed/produced. Job is advisory (never added to required checks).

- [ ] **Step 1: Run shellcheck locally and fix findings**

```bash
brew list shellcheck >/dev/null 2>&1 || brew install shellcheck
shellcheck scripts/*.sh
```

Fix every finding in the scripts (typical: quote `$(lsof ...)` expansions, `read -r`). Re-run until clean exit 0. Do not suppress with directives unless the finding is a true false-positive — then use a targeted `# shellcheck disable=SCnnnn` with a reason comment.

- [ ] **Step 2: Add the hygiene job**

```yaml
  # Advisory checks — deliberately NOT in the required-checks list: an audit false positive
  # must not freeze merges. Red here means "look", not "stop".
  hygiene:
    name: hygiene
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/setup

      - name: Dependency audit (prod, high+)
        continue-on-error: true
        run: pnpm audit --prod --audit-level high

      - name: shellcheck
        run: shellcheck scripts/*.sh

      - name: actionlint
        run: |
          bash <(curl -sSL https://raw.githubusercontent.com/rhysd/actionlint/main/scripts/download-actionlint.bash)
          ./actionlint -color
```

(shellcheck is preinstalled on ubuntu-latest runners.)

- [ ] **Step 3: Run actionlint locally against the workflows**

```bash
cd /Users/ckeller/src/stamm-greif && bash <(curl -sSL https://raw.githubusercontent.com/rhysd/actionlint/main/scripts/download-actionlint.bash) >/dev/null && ./actionlint -color; rm -f actionlint
```

Expected: no findings (fix any it reports — shell-quoting inside `run:` blocks is the usual).

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml scripts/
git commit -m "ci: advisory hygiene job (audit, shellcheck, actionlint)"
```

---

### Task 8: Release workflow (GHCR) + compose image + betrieb.md

**Files:**
- Create: `.github/workflows/release.yml`
- Modify: `docker-compose.yml` (app service `image:`)
- Modify: `docs/betrieb.md` (pull-based deploy path)

**Interfaces:**
- Produces: image `ghcr.io/ckeller42/stamm-greif:latest` and `:sha-<7>` on every main push.

- [ ] **Step 1: Write release.yml**

```yaml
name: Release

on:
  push:
    branches: [main]

jobs:
  image:
    name: publish image
    runs-on: ubuntu-latest
    timeout-minutes: 20
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4

      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Short SHA
        id: sha
        run: echo "short=${GITHUB_SHA::7}" >> "$GITHUB_OUTPUT"

      - uses: docker/build-push-action@v6
        with:
          context: .
          target: run
          push: true
          tags: |
            ghcr.io/ckeller42/stamm-greif:latest
            ghcr.io/ckeller42/stamm-greif:sha-${{ steps.sha.outputs.short }}
```

- [ ] **Step 2: Add the image name to compose**

In `docker-compose.yml`, `app` service, directly under `build:`'s block (same indent level as `build:`):

```yaml
    image: ghcr.io/ckeller42/stamm-greif:latest
```

(Compose semantics: with both `image:` and `build:`, `up --build`/`compose build` builds and tags locally under that name; `compose pull app` fetches the registry copy. Both deploy paths keep working.)

- [ ] **Step 3: Document the pull-based deploy in betrieb.md**

In `docs/betrieb.md`, after the Erststart section's compose commands, add:

```markdown
### Deployment per fertigem Image (Alternative ohne Server-Build)

Jeder Merge auf `main` veröffentlicht das fertige Produktions-Image als
`ghcr.io/ckeller42/stamm-greif:latest` (GitHub Container Registry). Statt auf dem Server zu
bauen, kann man es direkt ziehen — schneller und braucht kaum RAM:

```sh
docker compose pull app
docker compose up -d
```

(Beim allerersten Mal ggf. `docker login ghcr.io` mit einem GitHub-Token, falls das Paket nicht
öffentlich ist. Migrationen wie gehabt vorher per `docker compose run --rm migrate`.)
```

- [ ] **Step 4: Validate YAML + commit**

```bash
python3 -c "import yaml; [yaml.safe_load(open(f)) for f in ['.github/workflows/release.yml','docker-compose.yml']]; print('YAML OK')"
git add .github/workflows/release.yml docker-compose.yml docs/betrieb.md
git commit -m "ci: publish GHCR image on main; document pull-based deploy"
```

---

### Task 9: Dependabot

**Files:**
- Create: `.github/dependabot.yml`

- [ ] **Step 1: Write it**

```yaml
version: 2
updates:
  # Security updates: as fast as possible.
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: daily
    open-pull-requests-limit: 5
    # Version bumps ride the monthly grouped PR below; this entry only surfaces security fixes
    # in between by keeping the daily cadence with grouping disabled for security updates.
    groups:
      npm-minor-patch:
        update-types: [minor, patch]
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: monthly
```

- [ ] **Step 2: Validate + commit**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/dependabot.yml')); print('YAML OK')"
git add .github/dependabot.yml
git commit -m "ci: dependabot — grouped npm updates + monthly actions bumps"
```

---

### Task 10: Push, CI verification, PR — then post-merge steps

**Files:** none (operations).

- [ ] **Step 1: Full local gate before pushing**

```bash
pnpm lint && pnpm exec tsc --noEmit && pnpm test:unit && pnpm test:e2e
```

Expected: all green (int tests skipped here — they need the app server; CI covers them).

- [ ] **Step 2: Push and watch CI**

```bash
git push -u origin ci-hardening
sleep 10 && gh run list --branch ci-hardening --limit 1
# poll gh run view <id> until completed; ALL of test, e2e, docker, hygiene must succeed
```

Expected: `test`, `e2e`, `docker` success. `hygiene` success (or investigate). Iterate here until green — CI-behavior differences (runner paths, cache misses) surface at this step, not earlier.

- [ ] **Step 3: Open the PR**

```bash
gh pr create --base main --head ci-hardening --title "CI hardening: Docker verification, GHCR releases, drift check, e2e on prod build" --body "Closes the ten pipeline gaps per docs/superpowers/specs/2026-08-05-ci-pipeline-hardening-design.md. New required checks: test, e2e, docker (build job removed). hygiene is advisory. Release workflow publishes ghcr.io/ckeller42/stamm-greif on main pushes."
```

Address CodeRabbit review; all conversations must be resolved (branch protection).

- [ ] **Step 4: USER GATE — merge**

Ask the user to approve merging. Note: the required check `build` no longer exists on this branch's runs, so the PR will show it as "expected" and block. Resolution: update branch protection FIRST (swap `build` → `docker` in required contexts), then merge:

```bash
gh api --method PUT /repos/ckeller42/stamm-greif/branches/main/protection --input - <<'EOF'
{
  "required_status_checks": { "strict": true, "contexts": ["test", "e2e", "docker"] },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "required_conversation_resolution": true
}
EOF
gh pr merge <PR#> --merge --delete-branch
```

- [ ] **Step 5: Verify the release workflow on main**

```bash
sleep 15 && gh run list --workflow release.yml --limit 1
# wait for success, then prove the artifact:
docker pull ghcr.io/ckeller42/stamm-greif:latest
docker run --rm ghcr.io/ckeller42/stamm-greif:latest node --version
```

Expected: pull succeeds, prints the Node 22 version. (If pull is denied: the package defaults to private — either `gh auth token | docker login ghcr.io -u ckeller42 --password-stdin` first, or make the package public in GitHub package settings.)

- [ ] **Step 6: Update the memory/ops docs if anything drifted**

If any command in `docs/betrieb.md` changed behaviour during implementation, fix the doc in a follow-up commit on main via PR.

---

## Self-review (done at write time)

- **Spec coverage:** all ten gaps map to tasks — docker artifact (T6), CD/GHCR (T8), drift (T2), timeouts (T1), dependabot+audit+shellcheck+actionlint (T7, T9), prod-build e2e (T3), Playwright cache (T3), coverage (T2), journeys (T4, T5). Branch-protection swap (spec Rollout) in T10.
- **Placeholder scan:** every step has runnable code/commands; the two genuinely uncertain UI-string/API-shape spots (invite alert text, draft-query shape) carry explicit fallback instructions instead of hand-waving.
- **Type consistency:** `.seed.json` field names (`inviteToken`, `memberB`, `kurator`) match between T4 (producer) and T5 (consumer); check names `test`/`e2e`/`docker` consistent across T1/T6/T10.
