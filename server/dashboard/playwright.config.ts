import { defineConfig } from '@playwright/test'

/**
 * Local D1 smoke. Not wired into CI yet (needs `npx playwright install`).
 *   npm run build && npx vite preview --port 4173 &
 *   npx playwright test
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:4173',
    headless: true,
  },
})
