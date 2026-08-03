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
import { Places } from './collections/Places'
import { Tags } from './collections/Tags'
import { Users } from './collections/Users'

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
  // Later tasks add further collections (e.g. Task 7 adds Photos).
  collections: [Users, Invites, People, Groups, Memberships, Events, EventSeries, Places, Tags, Attendance],
  editor: lexicalEditor(),
  secret,
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
})
