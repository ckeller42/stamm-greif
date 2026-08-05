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
