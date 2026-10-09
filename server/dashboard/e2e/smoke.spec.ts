/**
 * D1 Playwright smoke (local / optional CI).
 * Run: npx playwright test --config=playwright.config.ts
 */
import { test, expect } from '@playwright/test'

test.describe('dashboard smoke', () => {
  test('login gate visible', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByText(/Neyra|ключ|вход|дашборд/i).first()).toBeVisible({ timeout: 15000 })
  })
})
