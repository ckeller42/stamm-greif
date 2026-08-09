import { postgresAdapter } from '@payloadcms/db-postgres'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { de } from '@payloadcms/translations/languages/de'
import { en } from '@payloadcms/translations/languages/en'
import path from 'path'
import { buildConfig } from 'payload'
import { fileURLToPath } from 'url'
import sharp from 'sharp'

import { Attendance } from './collections/Attendance'
import { EventSeries } from './collections/EventSeries'
import { Events } from './collections/Events'
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

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

const secret = process.env.PAYLOAD_SECRET
if (!secret) {
  throw new Error('PAYLOAD_SECRET is required')
}

export default buildConfig({
  admin: {
    user: Users.slug,
    importMap: {
      baseDir: path.resolve(dirname),
    },
  },
  i18n: { supportedLanguages: { de, en }, fallbackLanguage: 'de' },
  // Users is a scaffold default required for admin auth (admin.user binds to it).
  // Invites powers invite-only onboarding (POST /api/invites/accept).
  collections: [Users, Invites, People, Groups, Memberships, Events, EventSeries, Places, Tags, Attendance, Photos],
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
  // 30-day Papierkorb auto-purge (spec §5). purgePapierkorbTask's own `schedule` is what
  // enqueues the job daily at 04:00; `autoRun` here is the separate piece that actually runs
  // whatever's sitting in the queue — see that task's top-of-file comment for the two-part
  // reasoning (both verified against this version's payload.d.ts). Not gated behind
  // NODE_ENV/similar: the int test (tests/int/papierkorb.int.test.ts) queues+runs the task
  // directly rather than waiting on the cron, so this being always-on in every environment
  // (including the vitest/int process, which does call getPayload()) is intentional, not an
  // oversight — an idle daily cron with nothing due to purge is a no-op.
  jobs: {
    tasks: [purgePapierkorbTask],
    autoRun: [{ cron: '0 4 * * *', queue: 'default' }],
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
