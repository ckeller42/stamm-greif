import { postgresAdapter } from '@payloadcms/db-postgres'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { de } from '@payloadcms/translations/languages/de'
import { en } from '@payloadcms/translations/languages/en'
import path from 'path'
import { buildConfig, type PayloadRequest } from 'payload'
import { fileURLToPath } from 'url'
import sharp from 'sharp'

import { Attendance } from './collections/Attendance'
import { EventSeries } from './collections/EventSeries'
import { Events } from './collections/Events'
import { FaceSuggestions } from './collections/FaceSuggestions'
import { Groups } from './collections/Groups'
import { Invites } from './collections/Invites'
import { Memberships } from './collections/Memberships'
import { People } from './collections/People'
import { Photos } from './collections/Photos'
import { Places } from './collections/Places'
import { Tags } from './collections/Tags'
import { Users } from './collections/Users'
import { newErrorId, recordError, sanitizeUrl } from '@/lib/telemetry'
import { purgePapierkorbTask } from '@/jobs/purgePapierkorb'
import { detectFacesTask } from '@/jobs/detectFaces'
import { isAdmin } from '@/access/roles'

// Fix round 1 (H2): every jobs.access.* callback (run/queue/cancel) has the same `{ req }` arg
// shape, but a NARROWER return type (MaybePromise<boolean>) than the collection-level `Access`
// type `isAdmin` already has (AccessResult = boolean | Where) — TS rejects passing `isAdmin`
// directly here even though it never actually returns a `Where`. One small admin-only check,
// reused for all three, avoids that mismatch without an `as` cast.
const jobsAccessAdminOnly = ({ req }: { req: PayloadRequest }): boolean => req.user?.role === 'admin'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

const secret = process.env.PAYLOAD_SECRET
if (!secret) {
  throw new Error('PAYLOAD_SECRET is required')
}

const configPromise = buildConfig({
  admin: {
    user: Users.slug,
    importMap: {
      baseDir: path.resolve(dirname),
    },
  },
  i18n: { supportedLanguages: { de, en }, fallbackLanguage: 'de' },
  // Users is a scaffold default required for admin auth (admin.user binds to it).
  // Invites powers invite-only onboarding (POST /api/invites/accept).
  collections: [Users, Invites, People, Groups, Memberships, Events, EventSeries, Places, Tags, Attendance, Photos, FaceSuggestions],
  editor: lexicalEditor(),
  secret,
  // Structured JSON logs to stdout (pino). Without this Payload is near-silent in the
  // standalone container — the motivating incident produced zero log lines.
  logger: { options: { level: 'info' }, destination: process.stdout },
  typescript: {
    outputFile: path.resolve(dirname, 'payload-types.ts'),
  },
  db: postgresAdapter({
    pool: {
      connectionString: process.env.DATABASE_URI || '',
    },
  }),
  sharp,
  upload: { limits: { fileSize: 100 * 1024 * 1024 } }, // 100 MB (global constraint)
  plugins: [],
  // 30-day Papierkorb auto-purge (spec §5). purgePapierkorbTask's own `schedule` (`0 4 * * *`)
  // is what enqueues the job daily at 04:00. Not gated behind NODE_ENV/similar: the int test
  // (tests/int/papierkorb.int.test.ts) queues+runs the task directly rather than waiting on the
  // cron, so this being always-on in every environment (including the vitest/int process, which
  // does call getPayload()) is intentional, not an oversight — an idle daily cron with nothing
  // due to purge is a no-op.
  jobs: {
    tasks: [purgePapierkorbTask, detectFacesTask],
    // P2.3 review (Task 3, round 2): two enqueues for the same photo close together (publish,
    // then a quick file-replace before the first job has run) land as two separate rows in
    // `payload_jobs`. Without this, `runJobs`' `Promise.all` batch (queues/operations/runJobs/
    // index.js) can pick both up on the same tick and run them truly concurrently — both read
    // an empty `decided` set before either has written anything, so detectFacesHandler's own
    // idempotency (delete-then-recreate 'offen' rows) never gets a chance to fire, and the
    // kurator sees duplicate offen rows for the same face. `enableConcurrencyControl` is the
    // documented, built-in fix for exactly this (node_modules/payload/dist/queues/config/types/
    // index.d.ts's own doc comment: "prevent race conditions" via a `concurrencyKey` field)
    // rather than a hand-rolled "skip enqueue if a pending row already exists" check, which would
    // still race the same way against a job that's already `processing: true` when the second
    // enqueue's own existence-check query runs. detectFacesTask's own `concurrency` (see
    // src/jobs/detectFaces.ts) is what actually opts `detectFaces` into it — this flag only turns
    // the mechanism on and adds the (indexed, nullable) `concurrencyKey` column every other task
    // leaves unset, so purgePapierkorb's own jobs are entirely unaffected. Requires a migration
    // (see the concurrency_key migration) — the type's own doc comment says so explicitly.
    enableConcurrencyControl: true,
    // Fix round 1 (M4): `autoRun` only ever RUNS jobs already sitting in the queue — it does
    // not enqueue new ones (that's `schedule`, above). A daily `autoRun` cron here was wrong on
    // two counts: (1) it enqueues-then-immediately-runs on the same tick only by coincidence of
    // both being `0 4 * * *` — `enqueue` actually sets `waitUntil` to the task's *next* cron
    // occurrence (i.e. tomorrow 04:00) relative to when it fires, so a daily autoRun tick and a
    // daily schedule tick racing at the same instant is fragile, not by-design simultaneity; (2)
    // if that one autoRun tick is ever missed (deploy/restart mid-tick, brief downtime), the job
    // sits queued and unrun for a full extra day. Running the (cheap — no-op unless something's
    // actually due) autoRun check every 15 minutes instead means a missed tick costs minutes,
    // not a day, while the daily cadence itself still lives solely in the task's own `schedule`.
    //
    // P2.3: the `faces` queue runs every minute (suggestions should appear while the kurator is
    // still at the screen) but with a `limit`, so the one-off full backfill (Task 7) drains at a
    // fixed, self-throttling rate instead of saturating the box.
    autoRun: [
      { cron: '*/15 * * * *', queue: 'default' },
      { cron: '* * * * *', queue: 'faces', limit: 10 },
    ],
    // Fix round 1 (H2): with no `access` block, every jobs.access.* callback defaults to
    // Payload's `defaultAccess` (`Boolean(user)` — auth/defaultAccess.js) or, on some call
    // sites, an unconditional `() => true` fallback when `access.<op>` itself is undefined
    // (verified directly: queues/localAPI.js's `queue`/`cancel` and queues/endpoints/run.js's
    // `run` all do `jobsConfig.access?.<op> ?? (() => true)`) — i.e. ANY authenticated member,
    // or possibly anyone at all, could hit `GET /api/payload-jobs/run` and force-run the purge
    // (or any future task) on demand, queue arbitrary jobs, or cancel others'. `run` is the one
    // with an actual public HTTP endpoint (queues/endpoints/run.js + handleSchedules.js both
    // gate on `access.run` specifically); `queue`/`cancel` have no dedicated endpoint of their
    // own today (queuing externally would go through `POST /api/payload-jobs`, closed below via
    // `jobsCollectionOverrides`) but are locked down too for defense-in-depth/consistency — our
    // own code only ever calls them with `overrideAccess: true`, so this can't lock us out.
    access: { run: jobsAccessAdminOnly, queue: jobsAccessAdminOnly, cancel: jobsAccessAdminOnly },
    // Fix round 1 (H2): the auto-generated `payload-jobs` collection (job docs + their run
    // logs) otherwise ships with NO `access` block at all — same open-by-default problem as
    // above, but for the collection's own REST/GraphQL CRUD (`POST`/`GET`/`PATCH`/`DELETE
    // /api/payload-jobs[/:id]`). `jobsCollectionOverrides` is the one officially documented
    // escape hatch for this (JobsConfig type, queues/config/types/index.d.ts) — spread the
    // default collection Payload would have built and just add `access`.
    jobsCollectionOverrides: ({ defaultJobsCollection }) => ({
      ...defaultJobsCollection,
      access: { create: isAdmin, delete: isAdmin, read: isAdmin, update: isAdmin },
    }),
  },
  hooks: {
    afterError: [
      ({ error, req, result, collection }) => {
        const errorId = newErrorId()
        recordError({
          errorId,
          msg: error.message,
          stack: error.stack,
          path: sanitizeUrl(req?.url ?? undefined),
          user: req?.user?.id ?? undefined, // opaque ID, not email — keeps PII out of logs
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
})

// Fix round 1 (H2): the auto-injected `payload-jobs-stats` global (scheduling bookkeeping —
// last-run timestamps per queue/task, no user data) has NO override hook at all in 3.87 —
// unlike the jobs collection's `jobsCollectionOverrides`, `JobsConfig` exposes nothing for this
// global (verified directly: queues/config/global.js's `getJobStatsGlobal` always builds it
// access-less, and config/sanitize.js pushes the result into `config.globals` unconditionally,
// with no check for a user-supplied global of the same slug to merge with). Left alone it's
// open to `Boolean(user)` read/update, same class of gap as the jobs collection.
// `buildConfig()` returns the fully sanitized `Config` as a Promise; access checks read
// `global.access.read`/`.update` off that same object live, at request time — so mutating it
// here, once, right after the promise resolves and before any request is ever served, closes
// the gap exactly as if it had been declared upfront. `.then()` (not `await`, since this module
// has no top-level-await) keeps the export's existing `Promise<Config>` shape, which every
// caller already accommodates (`getPayload({ config: await config })`).
export default configPromise.then((config) => {
  const statsGlobal = config.globals.find((g) => g.slug === 'payload-jobs-stats')
  // CodeRabbit (PR #18): fail loudly, not silently, if the slug this lockdown targets ever
  // stops existing — e.g. a future Payload minor renaming `payload-jobs-stats`, or restructuring
  // how/whether it's auto-injected. Silently skipping would mean this access lockdown just
  // quietly stops applying with no signal anywhere; the H2 int-test pin (tests/int/
  // papierkorb.int.test.ts) only proves the CURRENT global is locked down, it can't prove some
  // future global under a different name isn't wide open. Throwing at config-build time (boot,
  // before the app ever serves a request) turns that into an immediate, unmissable failure
  // instead of a silent security regression discovered later, if ever.
  if (!statsGlobal) {
    throw new Error(
      "payload.config.ts: expected an auto-injected 'payload-jobs-stats' global after " +
        'buildConfig() (this app enables jobs.tasks with a `schedule`, which sanitizeConfig is ' +
        "expected to turn into jobs.stats=true and inject that global — see queues/config/" +
        'global.js\'s getJobStatsGlobal and config/sanitize.js in payload@3.87.0), but it was ' +
        'not found. This almost certainly means a Payload version change altered that behavior ' +
        '(renamed the slug, stopped auto-injecting it, or similar) — the access lockdown just ' +
        'below (fix round 1, H2) that depends on finding this exact global would otherwise ' +
        'silently stop applying, leaving job-scheduling bookkeeping open to any authenticated ' +
        'user. Find out what changed and update this code (and the slug check) accordingly ' +
        'before deploying.',
    )
  }
  statsGlobal.access = { read: isAdmin, readVersions: isAdmin, update: isAdmin }
  return config
})
