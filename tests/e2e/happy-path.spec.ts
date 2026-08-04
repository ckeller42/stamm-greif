// E2E happy path (Task 15): the core member journey through the archive.
//
//   anonymous → login gate → sign in → archive gallery → open a person → open an event → logout
//
// Fixtures (a member account plus a published photo tagged with one person and one event) are
// seeded by global-setup.ts, which drops their IDs/credentials into .seed.json.
import { test, expect } from '@playwright/test'
import { readFileSync } from 'fs'
import { SEED_FILE } from './global-setup'

const seed = JSON.parse(readFileSync(SEED_FILE, 'utf8')) as {
  email: string
  password: string
  personId: number
  eventId: number
  caption: string
}

test('member signs in, browses the archive, and signs out', async ({ page }) => {
  // 1. Anonymous visit to the archive is bounced to the login page.
  await page.goto('/')
  await expect(page).toHaveURL(/\/anmelden$/)
  await expect(page.getByRole('heading', { name: 'Anmelden' })).toBeVisible()

  // 2. Sign in with the seeded member credentials.
  await page.getByLabel('E-Mail').fill(seed.email)
  await page.getByLabel('Passwort').fill(seed.password)
  await page.getByRole('button', { name: 'Anmelden' }).click()

  // 3. Land on the archive gallery and see the seeded (published) photo.
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('heading', { name: 'Archiv', level: 1 })).toBeVisible()
  await expect(page.getByText(seed.caption)).toBeVisible()

  // 4. Open the tagged person's page — heading is the person's name.
  await page.goto(`/personen/${seed.personId}`)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('E2E Person')

  // 5. Open the tagged event's page — heading is the event's name.
  await page.goto(`/ereignisse/${seed.eventId}`)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('E2E Ereignis')

  // 6. Sign out — the archive is auth-gated, so logging out lands back on the login page.
  await page.getByRole('link', { name: 'Abmelden' }).click()
  await expect(page).toHaveURL(/\/anmelden$/)
  await expect(page.getByRole('heading', { name: 'Anmelden' })).toBeVisible()
})
