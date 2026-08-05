// Playwright global setup (Task 15). Seeds a deterministic happy-path fixture set into the dev
// DB via Payload's Local API, then writes the credentials + created IDs to `.seed.json` for the
// spec to read. Runs against the same DATABASE_URI as the `pnpm dev` webServer (localhost:5432,
// docker-compose.dev.yml's `db`), so both share one database.
//
// Why seed here rather than click through the UI: the happy path needs a *published, visible*
// photo, but a member self-uploading can only ever create a draft (Photos' beforeChange guard).
// Seeding with overrideAccess + no user is a trusted system context, so the guard is skipped and
// we can land an already-published photo — the realistic post-moderation state a member sees.
import { getPayload } from 'payload'
import config from '@payload-config'
import path from 'path'
import { fileURLToPath } from 'url'
import { writeFileSync } from 'fs'

const dirname = path.dirname(fileURLToPath(import.meta.url))
export const SEED_FILE = path.join(dirname, '.seed.json')

export default async function globalSetup() {
  const payload = await getPayload({ config })

  // Unique per run so repeated runs against the persistent dev-db volume never collide on the
  // users email unique index (same discipline the integration tests use).
  const stamp = Date.now()
  const email = `e2e-${stamp}@example.com`
  const password = 'geheim123'

  await payload.create({
    collection: 'users',
    data: { name: 'E2E Mitglied', email, password, role: 'mitglied' },
    overrideAccess: true,
  })

  const person = await payload.create({
    collection: 'people',
    data: { name: `E2E Person ${stamp}` },
    overrideAccess: true,
  })

  const event = await payload.create({
    collection: 'events',
    // datePrecision carries a runtime default ('unknown') but is typed required, so it's set
    // explicitly here to satisfy the generated Options type.
    data: { name: `E2E Ereignis ${stamp}`, datePrecision: 'unknown' },
    overrideAccess: true,
  })

  const caption = `E2E Foto ${stamp}`
  const photo = await payload.create({
    collection: 'photos',
    // No `user` in the request → trusted context → the moderation guard leaves _status alone,
    // so this photo is published and visible to the seeded member in the archive.
    data: { caption, datePrecision: 'unknown', _status: 'published', people: [person.id], event: event.id },
    filePath: path.join(dirname, '..', 'fixtures', 'dia.jpg'),
    overrideAccess: true,
  })

  writeFileSync(
    SEED_FILE,
    JSON.stringify(
      { email, password, personId: person.id, eventId: event.id, caption, photoId: photo.id },
      null,
      2,
    ),
  )
}
