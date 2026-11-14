#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const webDir = join(repoRoot, 'web');

const PORT = 3456;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CHROMIUM_PATH = '/usr/bin/chromium';
const DB_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/neyra';

// Parse arguments
const args = process.argv.slice(2);
const isBaseline = args.includes('--baseline');
const isQuick = args.includes('--quick'); // only baseline screens (chat, admin)
const specificScreen = args.find(a => a.startsWith('--screen='))?.split('=')[1];

async function getCommitHash() {
  try {
    const { execSync } = await import('node:child_process');
    return execSync('git rev-parse HEAD', { cwd: repoRoot, encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown-commit';
  }
}

async function isServerReady() {
  try {
    const res = await fetch(`${BASE_URL}/login`, { signal: AbortSignal.timeout(1500) });
    return res.status === 200;
  } catch {
    return false;
  }
}

async function ensureStaticAssets() {
  const staticSrc = join(webDir, '.next/static');
  const staticDest = join(webDir, '.next/standalone/web/.next/static');
  const publicSrc = join(webDir, 'public');
  const publicDest = join(webDir, '.next/standalone/web/public');

  const { cpSync } = await import('node:fs');
  if (existsSync(staticSrc) && !existsSync(staticDest)) {
    console.log('[ui-shots] Copying .next/static to standalone build...');
    cpSync(staticSrc, staticDest, { recursive: true });
  }
  if (existsSync(publicSrc) && !existsSync(publicDest)) {
    cpSync(publicSrc, publicDest, { recursive: true });
  }
}

async function startServer() {
  await ensureStaticAssets();

  if (await isServerReady()) {
    console.log(`[ui-shots] Using existing server on ${BASE_URL}`);
    return null;
  }

  console.log(`[ui-shots] Starting Next.js standalone server on port ${PORT}...`);
  const serverJs = join(webDir, '.next/standalone/web/server.js');
  if (!existsSync(serverJs)) {
    throw new Error(`Standalone server not found at ${serverJs}. Run 'npm run build' first.`);
  }

  const child = spawn(process.execPath, [serverJs], {
    cwd: webDir,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOSTNAME: '127.0.0.1',
      DATABASE_URL: DB_URL,
      BETTER_AUTH_SECRET: 'supersecretbetterauthsecret32charslong!',
      BETTER_AUTH_URL: BASE_URL,
      NODE_ENV: 'production',
    },
    stdio: 'ignore',
  });

  // Wait for server to be ready
  const start = Date.now();
  while (Date.now() - start < 15000) {
    if (await isServerReady()) {
      console.log(`[ui-shots] Server is ready on ${BASE_URL}`);
      return child;
    }
    await new Promise(r => setTimeout(r, 200));
  }
  child.kill();
  throw new Error('[ui-shots] Server failed to start within 15 seconds.');
}

async function loginAdmin() {
  console.log('[ui-shots] Authenticating test admin...');
  const res = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': BASE_URL,
    },
    body: JSON.stringify({
      email: 'admin@neyra.local',
      password: 'Password1234!',
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Login failed (${res.status}): ${text}`);
  }

  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) throw new Error('No set-cookie returned from login');

  const match = setCookie.match(/better-auth\.session_token=([^;]+)/);
  if (!match) throw new Error('Could not parse session token from cookie');

  return match[1];
}

function computeSha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function checkNoLoadingText(page) {
  const textContent = await page.evaluate(() => {
    // Check main content areas for "Загрузка" or "Loading"
    const el = document.querySelector('main') || document.body;
    return el ? el.innerText : '';
  });

  // Allowed contexts: small button loaders if any, but central full-page loading is forbidden
  const forbiddenPatterns = [
    /загрузка сводки админ-панели/i,
    /загрузка списка доступа/i,
    /загрузка истории/i,
    /загрузка диалога/i,
  ];

  for (const pat of forbiddenPatterns) {
    if (pat.test(textContent)) {
      throw new Error(`Detected forbidden loading screen pattern: ${pat}`);
    }
  }
}

async function main() {
  const commit = await getCommitHash();
  const commitShort = commit.slice(0, 8);
  const outDirName = isBaseline ? `shots/baseline-${commitShort}` : `shots/${commitShort}`;
  const outDir = join(repoRoot, outDirName);
  mkdirSync(outDir, { recursive: true });

  console.log(`=== UI Shots Collector ===`);
  console.log(`Commit: ${commit}`);
  console.log(`Output: ${outDir}`);

  let serverProcess = null;
  let browser = null;

  try {
    serverProcess = await startServer();
    const sessionToken = await loginAdmin();

    browser = await chromium.launch({
      executablePath: CHROMIUM_PATH,
      args: ['--no-sandbox', '--disable-gpu', '--font-render-hinting=none'],
    });

    const viewports = [
      { name: '1440', width: 1440, height: 900, isMobile: false },
      { name: '390', width: 390, height: 844, isMobile: true, hasTouch: true },
    ];

    const manifestItems = [];
    const shaMap = new Map();

    async function takeShot({ filename, screen, state, vp, setupFn, desc }) {
      if (specificScreen && screen !== specificScreen) return;
      console.log(`  -> Taking shot: ${filename} (${screen} / ${state} / ${vp.name})`);

      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        isMobile: vp.isMobile,
        hasTouch: vp.hasTouch,
        deviceScaleFactor: 1,
      });

      // Set auth cookie
      await context.addCookies([
        {
          name: 'better-auth.session_token',
          value: sessionToken,
          domain: '127.0.0.1',
          path: '/',
          httpOnly: true,
          sameSite: 'Lax',
        },
      ]);

      const page = await context.newPage();

      try {
        await setupFn(page);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(400); // allow layout/fonts to stabilize

        await checkNoLoadingText(page);

        const filePath = join(outDir, filename);
        const buf = await page.screenshot({ fullPage: false });
        writeFileSync(filePath, buf);

        const sha = computeSha256(buf);
        if (shaMap.has(sha)) {
          const prev = shaMap.get(sha);
          throw new Error(`DUPLICATE SCREENSHOT DETECTED!\nFile ${filename} has same sha256 as ${prev} (${sha}). Real visual differences are required!`);
        }
        shaMap.set(sha, filename);

        manifestItems.push({
          file: filename,
          screen,
          state,
          viewport: `${vp.width}x${vp.height}`,
          sha256: sha,
          commit,
          timestamp: new Date().toISOString(),
          description: desc,
        });
      } finally {
        await context.close();
      }
    }

    // Baseline screens
    for (const vp of viewports) {
      // 1. Chat empty state
      await takeShot({
        filename: `01-chat-empty-${vp.name}.png`,
        screen: 'chat',
        state: 'empty',
        vp,
        setupFn: async (page) => {
          await page.goto(`${BASE_URL}/chat`, { waitUntil: 'domcontentloaded' });
          await page.waitForSelector('[data-chat-shell], textarea, [role="textbox"]');
        },
        desc: 'Пустое состояние чата: чипсы сценариев, нейтральное поле ввода',
      });

      // 2. Admin dialog (Overview)
      await takeShot({
        filename: `02-admin-overview-${vp.name}.png`,
        screen: 'admin-overview',
        state: 'data',
        vp,
        setupFn: async (page) => {
          await page.goto(`${BASE_URL}/chat`, { waitUntil: 'domcontentloaded' });
          await page.waitForSelector('[data-chat-shell], textarea, [role="textbox"]');
          // Open admin dialog
          if (vp.isMobile) {
            // Click top-left button to open mobile sidebar drawer
            const sidebarBtn = await page.waitForSelector('button[aria-label="Открыть панель"]');
            await sidebarBtn.click();
            await page.waitForTimeout(400);
          }
          // Click user profile button at bottom of sidebar
          const profileBtn = await page.waitForSelector('button:has-text("Администратор"), button:has-text("Алексей")', { state: 'visible' });
          await profileBtn.click();
          await page.waitForTimeout(300);

          // Click "Админ-панель"
          const adminItem = await page.waitForSelector('button:has-text("Админ-панель")', { state: 'visible' });
          await adminItem.click();
          await page.waitForSelector('[role="dialog"][aria-modal="true"]');
          await page.waitForTimeout(800); // allow overview fetch to finish
        },
        desc: 'Модальное окно админки: обзор KPI, состояние ядра, доступ',
      });
    }

    if (!isQuick) {
      // Full screen suite
      for (const vp of viewports) {
        // 3. Login page (default)
        await takeShot({
          filename: `03-auth-login-${vp.name}.png`,
          screen: 'login',
          state: 'data',
          vp,
          setupFn: async (page) => {
            await page.context().clearCookies();
            await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('form, input[type="email"]');
          },
          desc: 'Форма входа: кнопка Discord, поле email, пароль с кнопкой показа',
        });

        // 4. Login page (error)
        await takeShot({
          filename: `04-auth-login-error-${vp.name}.png`,
          screen: 'login',
          state: 'error',
          vp,
          setupFn: async (page) => {
            await page.context().clearCookies();
            await page.goto(`${BASE_URL}/login?mockError=invalid`, { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('[role="alert"], .text-\\[var\\(--danger\\)\\]');
          },
          desc: 'Форма входа: ошибка валидации и неверных данных',
        });

        // 5. Signup page (invite code)
        await takeShot({
          filename: `05-auth-signup-invite-${vp.name}.png`,
          screen: 'signup',
          state: 'data',
          vp,
          setupFn: async (page) => {
            await page.context().clearCookies();
            await page.goto(`${BASE_URL}/signup?invite=DEMO_INVITE_TOKEN_VALID`, { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('form, input[type="email"]');
          },
          desc: 'Регистрация с подтверждённым инвайтом: плашка инвайта, поля регистрации',
        });

        // 6. Reset password (empty/missing token)
        await takeShot({
          filename: `06-auth-reset-password-${vp.name}.png`,
          screen: 'reset-password',
          state: 'error',
          vp,
          setupFn: async (page) => {
            await page.context().clearCookies();
            await page.goto(`${BASE_URL}/reset-password`, { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('[role="alert"]');
          },
          desc: 'Сброс пароля без токена: предупреждение о необходимости ссылки от администратора',
        });

        // 7. Settings dialog (Profile)
        await takeShot({
          filename: `07-settings-profile-${vp.name}.png`,
          screen: 'settings',
          state: 'data',
          vp,
          setupFn: async (page) => {
            await page.goto(`${BASE_URL}/chat`, { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('[data-chat-shell], textarea, [role="textbox"]');
            if (vp.isMobile) {
              const sidebarBtn = await page.waitForSelector('button[aria-label="Открыть панель"]');
              await sidebarBtn.click();
              await page.waitForTimeout(400);
            }
            const profileBtn = await page.waitForSelector('button:has-text("Администратор"), button:has-text("Алексей")', { state: 'visible' });
            await profileBtn.click();
            await page.waitForTimeout(300);

            const settingsItem = await page.waitForSelector('button:has-text("Настройки")', { state: 'visible' });
            await settingsItem.click();
            await page.waitForSelector('[role="dialog"][aria-modal="true"]');
            await page.waitForTimeout(400);
          },
          desc: 'Диалог настроек: профиль, аватар, роль, переключатели',
        });

        // 8. Thread panel opened
        await takeShot({
          filename: `08-thread-panel-${vp.name}.png`,
          screen: 'thread-panel',
          state: 'data',
          vp,
          setupFn: async (page) => {
            await page.goto(`${BASE_URL}/chat`, { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('[data-chat-shell], textarea, [role="textbox"]');
            // Click thread panel toggle button
            const threadBtn = await page.waitForSelector('button[aria-label*="свойства"], button[aria-label*="треда"], button[aria-label*="информация"]');
            await threadBtn.click();
            await page.waitForTimeout(300);
          },
          desc: 'Боковая панель треда: табы в одну строку, обзор, закреплённые',
        });
      }
    }

    // Write manifest.json
    const manifest = {
      commit,
      baseCommit: '8bdbf5eb4f0e928071f2d5b2fbd0cb0527936ccd',
      timestamp: new Date().toISOString(),
      nodeVersion: process.version,
      totalScreenshots: manifestItems.length,
      screenshots: manifestItems,
    };

    writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    console.log(`\n[ui-shots] Successfully captured ${manifestItems.length} unique screenshots.`);
    console.log(`[ui-shots] Manifest written to ${join(outDir, 'manifest.json')}`);

  } finally {
    if (browser) await browser.close();
    if (serverProcess) serverProcess.kill();
  }
}

main().catch((err) => {
  console.error('\n[ui-shots] ERROR:', err);
  process.exit(1);
});
