# CI Pipeline Hardening — Design

**Date:** 2026-08-05
**Status:** Approved
**Context:** The MVP merged to `main` with a working CI (`test`, `e2e`, `build` jobs) and
CodeRabbit review, but a gap review found ten holes. This design closes all ten. Decisions made
during brainstorming: cover everything, ship images to GHCR (no VPS auto-deploy yet), add invite
and upload/moderation e2e journeys, run e2e against the production build.

## Goals

1. CI verifies the actual production artifact (Docker image), not just `next build`.
2. Merges to `main` publish a deployable image (GHCR) so the VPS never builds from source.
3. Schema drift (collections changed without a committed migration) fails the PR.
4. Hung jobs cannot burn runner hours (timeouts everywhere).
5. Dependency and shell/workflow hygiene is visible without blocking merges.
6. E2E covers the three riskiest user journeys against the production server build.

**Non-goals:** VPS auto-deploy (no VPS exists), coverage threshold gates, image signing/SBOM,
e2e beyond the three journeys.

## Architecture

Four pieces, split by trigger semantics:

| Piece | File | Trigger | Role |
|---|---|---|---|
| Shared setup | `.github/actions/setup/action.yml` | (composite) | corepack + pnpm 11.18.0 pin, Node 22 + pnpm cache, `pnpm install --frozen-lockfile` |
| PR gate | `.github/workflows/ci.yml` | push/PR to `main` | required checks `test`, `e2e`, `docker` + advisory `hygiene` |
| Release | `.github/workflows/release.yml` | push to `main` | build + push GHCR image |
| Dep updates | `.github/dependabot.yml` | schedule | security daily, versions monthly grouped |

The previous bare `build` job (`pnpm build`) is removed: the `docker` job runs the same
`next build` inside the image build, so a separate job would duplicate work. Branch protection's
required checks change from `test, e2e, build` to `test, e2e, docker`.

## Jobs in detail

### `test` (timeout 15 min)

Existing flow (lint → typecheck → unit → integration with app server on the :5433 test DB) plus:

- **Migration drift check** (after typecheck, before unit): against the freshly-migrated test
  database, run `payload migrate:create` in a mode that skips writing when there is no diff
  (`--skip-empty` if supported by the installed Payload version; otherwise detect by whether a
  new file appeared in `src/migrations/`). If a migration file is generated, the collections
  changed without a committed migration → fail with the message
  `Schema drift: run pnpm payload migrate:create and commit the result`. Any generated file is
  discarded in CI.
- **Coverage**: unit tests run with `--coverage`; summary posted to the GitHub job summary.
  Report-only — no threshold gate (solo maintainer; gates invite ratcheting games).

### `e2e` (timeout 20 min)

- **Production build, not `next dev`**: in CI, Playwright's `webServer.command` becomes the
  real standalone invocation — `pnpm build`, copy `.next/static` and `public/` into
  `.next/standalone/` (mirroring the Dockerfile's COPY steps), then
  `node .next/standalone/server.js`. (`next start` does NOT serve `output: 'standalone'`
  builds — it falls back to the regular server, which would defeat the skew-killing purpose.)
  Keyed off the `CI` env var in `playwright.config.ts`; locally the config keeps `pnpm dev` +
  `reuseExistingServer` for fast iteration. A small `scripts/start-standalone.sh` wraps the
  copy+start so CI config stays one line. This kills dev/prod skew (force-dynamic behaviour,
  standalone tracing) that the pipeline never covered.
- **Playwright browser cache**: `~/Library/Caches/ms-playwright` / `~/.cache/ms-playwright`
  cached, keyed on the Playwright version from the lockfile — saves the ~100 MB download per run.
- **Three journeys** (`tests/e2e/`):
  1. *Happy path* (existing): login → archive shows seeded photo → person page → event page →
     logout.
  2. *Invite accept* (new): global-setup seeds an unused invite; test visits
     `/einladung/<token>`, fills name/email/password, submits → auto-login → lands on archive;
     re-visiting the invite link shows the invalid-invite message (single-use, the TOCTOU fix's
     user-visible contract).
  3. *Upload & moderation* (new): member A uploads a photo (draft) via `/hochladen`; member B's
     archive does not show it; a seeded kurator publishes it (via the Payload REST API with the
     kurator's session, not the admin UI — the admin SPA is out of e2e scope); member B now
     sees it.
- Seeds extend `tests/e2e/global-setup.ts` (second member, kurator, unused invite), written to
  the existing gitignored `.seed.json`.

### `docker` (new, timeout 15 min)

1. `docker compose build` (production `Dockerfile`, both stages — verifies `USER node`,
   `/app/photos` ownership, standalone copy paths).
2. Boot the full stack: `docker compose -f docker-compose.yml -f docker-compose.local.yml up -d`
   with a throwaway `.env` (`DB_PASSWORD`/`PAYLOAD_SECRET` generated in-job).
3. Run migrations in the stack (`docker compose run --rm migrate`).
4. Poll `curl -sf http://127.0.0.1/anmelden` through Caddy until HTTP 200 (bounded retries);
   fail with `docker compose logs` dump otherwise.
5. `docker compose down -v`.

This automates the manual smoke test done once during Task 14 and never repeated.

### `hygiene` (advisory — NOT a required check, timeout 10 min)

- `pnpm audit --prod --audit-level high` — reported, non-blocking step outcome.
- `shellcheck scripts/*.sh`.
- `actionlint` on the workflow files.

Visible red ✗ on the PR without freezing merges on audit false positives.

### `release.yml` (push to `main`, timeout 20 min)

- Log in to GHCR with `GITHUB_TOKEN` (`packages: write` permission block — no new secrets).
- Build the production image and push `ghcr.io/ckeller42/stamm-greif:latest` and
  `:sha-<7-char>`.
- `docker-compose.yml` gains `image: ghcr.io/ckeller42/stamm-greif:latest` alongside the
  existing `build:` block (Compose semantics: `build` wins locally with `--build`; `pull` path
  works without source). `docs/betrieb.md` documents both deploy paths: build-from-source
  (current) and `docker compose pull && docker compose up -d` (new, recommended once the image
  is public or the VPS is logged in to GHCR).

### `dependabot.yml`

- npm: security updates daily; version updates monthly, grouped into a single PR
  (minor+patch together). Major updates surface individually.
- github-actions: monthly.
- All Dependabot PRs run the full PR gate + CodeRabbit like any other PR.

## Error handling

- Drift check must fail *loudly* with the exact fix command in the failure message.
- Docker smoke failure dumps `docker compose logs` before exiting so the break is diagnosable
  from the CI log alone.
- Release job failure does not affect PR flow (separate workflow, `main` only).
- All jobs have `timeout-minutes`; the concurrency group cancels superseded runs (already in
  place).

## Testing / verification plan

- Drift check: verified by a scratch branch adding a throwaway collection field — CI must fail;
  removing it must pass. Verified once during implementation, then the scratch branch deleted.
- Docker job: verified by the existing stack (it passed manually in Task 14 — CI must reproduce).
- E2E journeys: run locally (dev DB) before pushing; then must pass in CI against the prod build.
- Release: verified by the real `main` push after merge; the pushed GHCR image is pulled and
  booted locally once as final proof.
- Branch protection: after the PR merges, required checks updated to `test, e2e, docker` via
  `gh api` (same call used previously).

## Rollout

Single PR (`ci-hardening` branch) containing everything except the branch-protection change,
which is applied by hand right after merge (it references the new check names). The release
workflow's first run happens on that same merge.
