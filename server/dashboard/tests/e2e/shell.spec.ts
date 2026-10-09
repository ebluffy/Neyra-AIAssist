import { expect, test } from '@playwright/test'
import path from 'node:path'

const shotDir = path.join('tests', 'e2e', 'screenshots')

test.describe('shell / gate', () => {
  test('gate shows login or setup and sets document title', async ({ page }, testInfo) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Neyra' })).toBeVisible()
    const title = await page.title()
    expect(title === 'Вход · Neyra' || title === 'Первичная настройка · Neyra').toBeTruthy()
    await page.screenshot({
      path: path.join(shotDir, `gate-${testInfo.project.name}.png`),
      fullPage: true,
    })
  })

  test('unknown path still shows gate until auth (no crash)', async ({ page }) => {
    await page.goto('/this-route-does-not-exist')
    await expect(page.getByRole('heading', { name: 'Neyra' })).toBeVisible()
  })
})
