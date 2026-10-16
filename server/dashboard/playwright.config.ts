import { defineConfig, devices } from '@playwright/test'

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:5173'

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 5'], viewport: { width: 390, height: 844 } } },
  ],
  webServer: process.env.PLAYWRIGHT_NO_SERVER
    ? undefined
    : [{
        command: `"${process.env.NEYRA_E2E_PYTHON ?? 'python'}" ../scripts/dashboard_e2e.py --port 18787`,
        url: 'http://127.0.0.1:18787/v1/dashboard/auth/status',
        reuseExistingServer: false,
        timeout: 30_000,
      }, {
        command: 'npm run dev -- --host 127.0.0.1 --port 5173',
        url: baseURL,
        env: { VITE_API_PROXY: 'http://127.0.0.1:18787' },
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      }],
})
