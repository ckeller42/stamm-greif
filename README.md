# Stamm-Greif-Archiv

Web-based photo archive & history system for Stamm Greif (Pfadfinderhorst Greif e.V.,
Bruchsal) — built for the 50-Jahre-Jubiläum 2027. Not a photo gallery: photos, people, groups
(Sippen/Meuten/Trupps), memberships and events form a real domain model that the community
organizes together.

**Stack:** [Payload CMS 3](https://payloadcms.com) embedded in [Next.js](https://nextjs.org)
(App Router, TypeScript), Postgres, German-first UI. Invite-only, no public registration.

## Development

1. `pnpm install`
2. `docker compose -f docker-compose.dev.yml up -d` — starts local Postgres (`db` on `:5432`,
   plus `db-test` on `:5433` for integration tests). That file pins an explicit Compose project
   name (`stamm-greif-dev`, distinct from the production compose file's `stamm-greif`) so the
   two files' identically-named `db` services can never collide and recreate each other's
   container on the wrong volume — this changed once (heic-support branch), which reset any
   existing local dev/test DB volumes; just re-run this step if your local data looks empty.
3. `cp .env.example .env` and fill in `PAYLOAD_SECRET` (`DATABASE_URI` already points at the
   dev db above)
4. `pnpm dev` — open `http://localhost:3000/anmelden`, follow the on-screen instructions to
   create the first admin user

Changes under `./src` hot-reload. See `docs/superpowers/specs/2026-08-03-scout-archive-design.md`
for the design spec and `docs/superpowers/plans/2026-08-03-archiv-mvp.md` for the build plan.

### Tests

`pnpm test` runs unit (`tests/unit`), integration (`tests/int`, against `db-test`), and e2e
(Playwright) suites in sequence. See `package.json` for the individual `test:*` scripts.

## Production deployment

One VPS, Docker Compose: the app (standalone Next.js build) + Postgres 17 + Caddy for
automatic HTTPS. Quick start:

```sh
cp .env.example .env   # fill in DB_PASSWORD and PAYLOAD_SECRET
docker compose up -d db
docker compose run --rm migrate   # apply DB schema
docker compose up -d --build
```

Full operations documentation — first start, backups, restore, monitoring, and the
schema-migration story — lives in **[`docs/betrieb.md`](docs/betrieb.md)** (German, for the
club's maintainers).

## Collections

See the [Collections](https://payloadcms.com/docs/configuration/collections) docs for how
Payload collections work in general. This app's domain collections (People, Groups,
Memberships, Events, EventSeries, Places, Tags, Attendance, Photos, Invites) live under
`src/collections/`; `Users` is the auth-enabled admin-login collection.

## Questions

Project-specific: see the design spec and plan under `docs/superpowers/`. For Payload itself,
see the [docs](https://payloadcms.com/docs) or [Discord](https://discord.com/invite/payload).
