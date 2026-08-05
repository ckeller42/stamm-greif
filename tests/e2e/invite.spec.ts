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
  // Scoped to the form: Next.js's own route-announcer div also carries role="alert" and would
  // otherwise make this a strict-mode violation (two matches).
  await expect(page.locator('form').getByRole('alert')).toContainText('Einladung')
})
