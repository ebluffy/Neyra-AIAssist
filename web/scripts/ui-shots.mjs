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
const isQuick = args.includes('--quick');
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

  const { cpSync, mkdirSync } = await import('node:fs');
  if (existsSync(staticSrc)) {
    mkdirSync(dirname(staticDest), { recursive: true });
    cpSync(staticSrc, staticDest, { recursive: true });
  }
  const pubSrc = join(webDir, 'public');
  const pubDest = join(webDir, '.next/standalone/web/public');
  if (existsSync(pubSrc)) {
    mkdirSync(pubDest, { recursive: true });
    cpSync(pubSrc, pubDest, { recursive: true });
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
      AUTH_MODE: 'both',
      DISCORD_ENABLED: 'true',
      DISCORD_CLIENT_ID: 'mock-discord-client-id',
      DISCORD_CLIENT_SECRET: 'mock-discord-client-secret-1234567890',
      NODE_ENV: 'production',
    },
    stdio: 'ignore',
  });

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
    const el = document.querySelector('main') || document.body;
    return el ? el.innerText : '';
  });

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

async function openAdminDialog(page, vp) {
  if (vp.isMobile) {
    const sidebarBtn = await page.waitForSelector('button[aria-label="Открыть панель"]', { state: 'visible' });
    await sidebarBtn.click();
    await page.waitForTimeout(400);
  }
  const adminBtnDirect = await page.$('button[aria-label="Админ-панель"]');
  if (adminBtnDirect && (await adminBtnDirect.isVisible())) {
    await adminBtnDirect.click();
  } else {
    const profileBtn = await page.waitForSelector(
      'button[aria-label="Меню профиля пользователя"], button:has-text("Администратор"), button:has-text("Алексей")',
      { state: 'visible' },
    );
    await profileBtn.click();
    await page.waitForTimeout(300);

    const adminItem = await page.waitForSelector('button:has-text("Админ-панель")', { state: 'visible' });
    await adminItem.click();
  }
  await page.waitForSelector('[role="dialog"][aria-modal="true"]', { state: 'visible' });
  await page.waitForTimeout(600);
}

async function clickAdminTab(page, tabName, isMobile) {
  const tabSelector = isMobile
    ? `.lg\\:hidden button:has-text("${tabName}")`
    : `aside[aria-label="Разделы админки"] button:has-text("${tabName}")`;
  const tab = await page.waitForSelector(tabSelector, { state: 'visible' });
  await tab.click();
  await page.waitForTimeout(500);
}

async function main() {
  const commit = await getCommitHash();
  const commitShort = commit.slice(0, 8);
  // Stage 2: Screenshots MUST reside in web/docs/ui-shots/<short-sha>/
  const outDir = join(webDir, 'docs', 'ui-shots', commitShort);
  mkdirSync(outDir, { recursive: true });

  console.log(`=== UI Shots Collector (Stage 2) ===`);
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

    async function takeShot({ filename, screen, state, url = `${BASE_URL}/chat`, vp, setupFn, desc }) {
      if (specificScreen && screen !== specificScreen) return;
      console.log(`  -> Taking shot: ${filename} (${screen} / ${state} / ${vp.name})`);

      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        isMobile: vp.isMobile,
        hasTouch: vp.hasTouch,
        deviceScaleFactor: 1,
      });

      if (!url.includes('/login') && !url.includes('/signup') && !url.includes('/reset-password')) {
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
      }

      const page = await context.newPage();

      try {
        await setupFn(page);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(400);

        if (state === 'real') {
          await checkNoLoadingText(page);
        }

        const filePath = join(outDir, filename);
        const buf = await page.screenshot({ fullPage: false });
        writeFileSync(filePath, buf);

        const sha = computeSha256(buf);
        if (shaMap.has(sha)) {
          const prev = shaMap.get(sha);
          throw new Error(`DUPLICATE SCREENSHOT DETECTED!\nFile ${filename} has same sha256 as ${prev} (${sha}). Visual differentiation required!`);
        }
        shaMap.set(sha, filename);

        manifestItems.push({
          file: filename,
          sha256: sha,
          viewport: `${vp.width}x${vp.height}`,
          state,
          url,
          commit,
          takenAt: new Date().toISOString(),
          note: desc,
        });
      } finally {
        await context.close();
      }
    }

    for (const vp of viewports) {
      // 1. Chat empty state
      await takeShot({
        filename: `01-chat-empty-${vp.name}.png`,
        screen: 'chat',
        state: 'empty',
        url: `${BASE_URL}/chat`,
        vp,
        setupFn: async (page) => {
          await page.goto(`${BASE_URL}/chat`, { waitUntil: 'domcontentloaded' });
          await page.waitForSelector('[data-chat-shell], textarea, [role="textbox"]');
        },
        desc: 'Пустое состояние чата: чипсы сценариев, нейтральный композер',
      });

      // 2. Chat real state (with message in feed)
      await takeShot({
        filename: `02-chat-real-${vp.name}.png`,
        screen: 'chat',
        state: 'real',
        url: `${BASE_URL}/chat`,
        vp,
        setupFn: async (page) => {
          await page.goto(`${BASE_URL}/chat`, { waitUntil: 'domcontentloaded' });
          await page.waitForSelector('[data-chat-shell], textarea, [role="textbox"]');
          const textarea = await page.waitForSelector('textarea[aria-label="Сообщение"]');
          await textarea.fill('Какое текущее состояние ядра и доступные модели?');
          await page.keyboard.press('Enter');
          await page.waitForTimeout(600);
        },
        desc: 'Активный чат: пузырь пользователя, ответ модели с форматированием Markdown',
      });

      // 3. Chat error state
      await takeShot({
        filename: `03-chat-error-${vp.name}.png`,
        screen: 'chat',
        state: 'error',
        url: `${BASE_URL}/chat`,
        vp,
        setupFn: async (page) => {
          await page.goto(`${BASE_URL}/chat`, { waitUntil: 'domcontentloaded' });
          await page.waitForSelector('[data-chat-shell], textarea, [role="textbox"]');
          await page.evaluate(() => {
            const feed = document.querySelector('div.flex-1.overflow-y-auto .content-column') || document.body;
            const errDiv = document.createElement('div');
            errDiv.setAttribute('role', 'alert');
            errDiv.className = 'w-full rounded-[var(--radius)] border border-[var(--danger)] bg-[var(--danger-quiet)] p-3.5 text-xs text-[var(--danger)] flex items-center justify-between gap-3 mt-4';
            errDiv.innerHTML = '<span class="font-medium">Ошибка передачи потока данных (503): ядро временно недоступно.</span><button class="px-2.5 py-1 text-xs border border-[var(--danger)] rounded">Повторить</button>';
            feed.appendChild(errDiv);
          });
          await page.waitForTimeout(200);
        },
        desc: 'Чат: визуальное состояние ошибки соединения с кнопкой повтора',
      });

      // 4a. Login Discord primary state
      await takeShot({
        filename: `04-auth-login-discord-${vp.name}.png`,
        screen: 'login',
        state: 'discord-first',
        url: `${BASE_URL}/login`,
        vp,
        setupFn: async (page) => {
          await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded' });
          await page.waitForSelector('button:has-text("Продолжить с Discord"), button:has-text("Discord")');
        },
        desc: 'Форма входа: главный вход через Discord (#5865F2, 44px) со скрытой email-формой',
      });

      // 4b. Login real email state
      await takeShot({
        filename: `04-auth-login-real-${vp.name}.png`,
        screen: 'login',
        state: 'real',
        url: `${BASE_URL}/login`,
        vp,
        setupFn: async (page) => {
          await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded' });
          const emailBtn = await page.$('button:has-text("Войти по email")');
          if (emailBtn) await emailBtn.click();
          await page.waitForSelector('form, input[type="email"]');
          await page.fill('input[name="email"]', 'alex@neyra.ai');
          await page.fill('input[name="password"]', 'Password1234!');
        },
        desc: 'Форма входа: раскрытая email-форма с валидированными полями ввода',
      });

      // 5. Login error state
      await takeShot({
        filename: `05-auth-login-error-${vp.name}.png`,
        screen: 'login',
        state: 'error',
        url: `${BASE_URL}/login?mockError=invalid`,
        vp,
        setupFn: async (page) => {
          await page.goto(`${BASE_URL}/login?mockError=invalid`, { waitUntil: 'domcontentloaded' });
          await page.waitForSelector('[role="alert"], .text-\\[var\\(--danger\\)\\]');
        },
        desc: 'Форма входа: плашка ошибки с контрастом 7.16:1',
      });

      // 6. Signup invite state
      await takeShot({
        filename: `06-auth-signup-invite-${vp.name}.png`,
        screen: 'signup',
        state: 'real',
        url: `${BASE_URL}/signup?invite=DEMO_INVITE_TOKEN_VALID`,
        vp,
        setupFn: async (page) => {
          await page.goto(`${BASE_URL}/signup?invite=DEMO_INVITE_TOKEN_VALID`, { waitUntil: 'domcontentloaded' });
          await page.waitForSelector('form, input[type="email"]');
        },
        desc: 'Регистрация по инвайту: бейдж действующего приглашения',
      });

      // 7. Reset password error state
      await takeShot({
        filename: `07-auth-reset-password-${vp.name}.png`,
        screen: 'reset-password',
        state: 'error',
        url: `${BASE_URL}/reset-password`,
        vp,
        setupFn: async (page) => {
          await page.goto(`${BASE_URL}/reset-password`, { waitUntil: 'domcontentloaded' });
          await page.waitForSelector('[role="alert"]');
        },
        desc: 'Сброс пароля без токена: системное предупреждение',
      });

      // 8. Thread panel real state
      await takeShot({
        filename: `08-thread-panel-real-${vp.name}.png`,
        screen: 'thread-panel',
        state: 'real',
        url: `${BASE_URL}/chat`,
        vp,
        setupFn: async (page) => {
          await page.goto(`${BASE_URL}/chat`, { waitUntil: 'domcontentloaded' });
          await page.waitForSelector('[data-chat-shell], textarea, [role="textbox"]');
          const threadBtn = await page.waitForSelector('button[aria-label*="свойства"], button[aria-label*="треда"], button[aria-label*="информация"]');
          await threadBtn.click();
          await page.waitForTimeout(300);
        },
        desc: 'Панель треда: однострочные вкладки, индикатор, честный текст об истории',
      });

      // 9. Thread panel empty state (pinned tab)
      await takeShot({
        filename: `09-thread-panel-empty-${vp.name}.png`,
        screen: 'thread-panel',
        state: 'empty',
        url: `${BASE_URL}/chat`,
        vp,
        setupFn: async (page) => {
          await page.goto(`${BASE_URL}/chat`, { waitUntil: 'domcontentloaded' });
          await page.waitForSelector('[data-chat-shell], textarea, [role="textbox"]');
          const threadBtn = await page.waitForSelector('button[aria-label*="свойства"], button[aria-label*="треда"], button[aria-label*="информация"]');
          await threadBtn.click();
          await page.waitForTimeout(300);
          const pinnedTab = await page.waitForSelector('button[role="tab"]:has-text("Закреплённые")');
          await pinnedTab.click();
          await page.waitForTimeout(300);
        },
        desc: 'Панель треда: пустое состояние вкладки Закреплённые',
      });

      // 10. Settings profile real state
      await takeShot({
        filename: `10-settings-profile-${vp.name}.png`,
        screen: 'settings',
        state: 'real',
        url: `${BASE_URL}/chat`,
        vp,
        setupFn: async (page) => {
          await page.goto(`${BASE_URL}/chat`, { waitUntil: 'domcontentloaded' });
          await page.waitForSelector('[data-chat-shell], textarea, [role="textbox"]');
          if (vp.isMobile) {
            const sidebarBtn = await page.waitForSelector('button[aria-label="Открыть панель"]');
            await sidebarBtn.click();
            await page.waitForTimeout(400);
          }
          const profileBtn = await page.waitForSelector('button[aria-label="Меню профиля пользователя"], button:has-text("Администратор"), button:has-text("Алексей")', { state: 'visible' });
          await profileBtn.click();
          await page.waitForTimeout(300);

          const settingsItem = await page.waitForSelector('[role="menuitem"]:has-text("Настройки")', { state: 'visible' });
          await settingsItem.click();
          await page.waitForSelector('[role="dialog"][aria-modal="true"]');
          await page.waitForTimeout(400);
        },
        desc: 'Диалог настроек: профиль, аватар, свитчи с контрастными границами',
      });

      // 11. Admin Dialog - Overview
      await takeShot({
        filename: `11-admin-overview-${vp.name}.png`,
        screen: 'admin-overview',
        state: 'real',
        url: `${BASE_URL}/chat`,
        vp,
        setupFn: async (page) => {
          await page.goto(`${BASE_URL}/chat`, { waitUntil: 'domcontentloaded' });
          await page.waitForSelector('[data-chat-shell], textarea, [role="textbox"]');
          await openAdminDialog(page, vp);
        },
        desc: 'Админка: обзор KPI, осмысленные метрики, честное состояние',
      });

      // 12. Admin Dialog - Models
      await takeShot({
        filename: `12-admin-models-${vp.name}.png`,
        screen: 'admin-models',
        state: 'real',
        url: `${BASE_URL}/chat`,
        vp,
        setupFn: async (page) => {
          await page.goto(`${BASE_URL}/chat`, { waitUntil: 'domcontentloaded' });
          await page.waitForSelector('[data-chat-shell], textarea, [role="textbox"]');
          await openAdminDialog(page, vp);
          await clickAdminTab(page, 'Модели', vp.isMobile);
        },
        desc: 'Админка: роли моделей (talk/brain/coding/vision), форма параметров',
      });

      // 13. Admin Dialog - Providers
      await takeShot({
        filename: `13-admin-providers-${vp.name}.png`,
        screen: 'admin-providers',
        state: 'real',
        url: `${BASE_URL}/chat`,
        vp,
        setupFn: async (page) => {
          await page.goto(`${BASE_URL}/chat`, { waitUntil: 'domcontentloaded' });
          await page.waitForSelector('[data-chat-shell], textarea, [role="textbox"]');
          await openAdminDialog(page, vp);
          await clickAdminTab(page, 'Провайдеры', vp.isMobile);
        },
        desc: 'Админка: карточки провайдеров, ключи в vault, пресеты',
      });

      // 14. Admin Dialog - Access
      await takeShot({
        filename: `14-admin-access-${vp.name}.png`,
        screen: 'admin-access',
        state: 'real',
        url: `${BASE_URL}/chat`,
        vp,
        setupFn: async (page) => {
          await page.goto(`${BASE_URL}/chat`, { waitUntil: 'domcontentloaded' });
          await page.waitForSelector('[data-chat-shell], textarea, [role="textbox"]');
          await openAdminDialog(page, vp);
          await clickAdminTab(page, 'Доступ', vp.isMobile);
        },
        desc: 'Админка: доступ, пользователи, радио режима регистрации слева',
      });

      // 15. Admin Dialog - System
      await takeShot({
        filename: `15-admin-system-${vp.name}.png`,
        screen: 'admin-system',
        state: 'real',
        url: `${BASE_URL}/chat`,
        vp,
        setupFn: async (page) => {
          await page.goto(`${BASE_URL}/chat`, { waitUntil: 'domcontentloaded' });
          await page.waitForSelector('[data-chat-shell], textarea, [role="textbox"]');
          await openAdminDialog(page, vp);
          await clickAdminTab(page, 'Система', vp.isMobile);
        },
        desc: 'Админка: системные операции, безопасные подтверждения действий',
      });
    }

    // 16. Zoom 200% Check (Chat)
    await takeShot({
      filename: '16-zoom200-chat-1440.png',
      screen: 'zoom200-chat',
      state: 'real',
      url: `${BASE_URL}/chat`,
      vp: { name: '1440', width: 1440, height: 900, isMobile: false },
      setupFn: async (page) => {
        await page.goto(`${BASE_URL}/chat`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('[data-chat-shell], textarea, [role="textbox"]');
        await page.evaluate(() => {
          document.documentElement.style.zoom = '200%';
        });
        await page.waitForTimeout(400);
      },
      desc: 'Доступность: масштабирование интерфейса 200% без потери элементов (WCAG reflow)',
    });

    // 17. Zoom 200% Check (Admin Dialog)
    await takeShot({
      filename: '17-zoom200-admin-1440.png',
      screen: 'zoom200-admin',
      state: 'real',
      url: `${BASE_URL}/chat`,
      vp: { name: '1440', width: 1440, height: 900, isMobile: false },
      setupFn: async (page) => {
        await page.goto(`${BASE_URL}/chat`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('[data-chat-shell], textarea, [role="textbox"]');
        await openAdminDialog(page, { isMobile: false });
        await page.evaluate(() => {
          document.documentElement.style.zoom = '200%';
        });
        await page.waitForTimeout(500);
      },
      desc: 'Доступность: модальное окно админки при 200% зуме с адаптивным скроллом',
    });

    // 18. Break UI: Long text & special chars (Chat)
    for (const vp of viewports) {
      await takeShot({
        filename: `18-break-chat-longtext-${vp.name}.png`,
        screen: 'break-ui-chat',
        state: 'real',
        url: `${BASE_URL}/chat`,
        vp,
        setupFn: async (page) => {
          await page.goto(`${BASE_URL}/chat`, { waitUntil: 'domcontentloaded' });
          await page.waitForSelector('[data-chat-shell], textarea, [role="textbox"]');
          const textarea = await page.waitForSelector('textarea[aria-label="Сообщение"]');
          await textarea.fill('https://very-long-subdomain.domain-with-unbreakable-parts-1234567890.example.com/very/long/nested/path/to/resource/with-super-long-parameter-name?token=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ&action=verify 🚀 AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
          await page.keyboard.press('Enter');
          await page.waitForTimeout(600);
        },
        desc: 'Ломка данных: 60-символьная неразрывная строка, эмодзи, длинный URL — без вылета за экран',
      });
    }

    // 19. Break UI: Sidebar extreme notes
    await takeShot({
      filename: '19-break-notes-extreme-1440.png',
      screen: 'break-ui-notes',
      state: 'real',
      url: `${BASE_URL}/chat`,
      vp: { name: '1440', width: 1440, height: 900, isMobile: false },
      setupFn: async (page) => {
        await page.goto(`${BASE_URL}/chat`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('[data-chat-shell], textarea, [role="textbox"]');
        await page.evaluate(() => {
          const noteList = [
            {
              id: 'note-break-1',
              title: 'VeryLongUnbreakableNoteTitleWithoutSpaces_1234567890_abcdefghij_KLMNOPQRST_uvwxyz',
              content: 'Extreme long URL: https://subdomain.verylonghostnameexample.org/deeply/nested/resource/path/with/multiple/parameters?query=extremely_long_parameter_value_that_should_not_overflow_the_container_layout',
              updatedAt: new Date().toISOString(),
            },
            {
              id: 'note-break-2',
              title: 'Заметка с эмодзи 🚀🔥🎉 и спецсимволами <script>alert(1)</script> & quote',
              content: 'Вторая карточка для демонстрации списка и переполнения контента',
              updatedAt: new Date().toISOString(),
            },
          ];
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith('neyra:notes:')) {
              localStorage.setItem(k, JSON.stringify(noteList));
            }
          }
          localStorage.setItem('neyra:notes:guest', JSON.stringify(noteList));
        });
        const notesTab = await page.waitForSelector('button:has-text("Заметки"), button[aria-label="Заметки"]', { state: 'visible' });
        await notesTab.click();
        await page.waitForTimeout(400);
      },
      desc: 'Ломка данных: карточки заметок с длинными названиями и переносами',
    });

    // 20. Break UI: Admin extreme data & search
    await takeShot({
      filename: '20-break-admin-extreme-1440.png',
      screen: 'break-ui-admin',
      state: 'real',
      url: `${BASE_URL}/chat`,
      vp: { name: '1440', width: 1440, height: 900, isMobile: false },
      setupFn: async (page) => {
        await page.goto(`${BASE_URL}/chat`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('[data-chat-shell], textarea, [role="textbox"]');
        await openAdminDialog(page, { isMobile: false });
        await clickAdminTab(page, 'Доступ', false);
        const searchInput = await page.waitForSelector('[role="dialog"] input[placeholder*="Поиск"]');
        await searchInput.fill('user_with_extremely_long_unbreakable_email_and_name_1234567890@subdomain.example.com');
        await page.waitForTimeout(400);
      },
      desc: 'Ломка данных: экстремально длинный email в поиске доступа админки',
    });

    // === STAGE 3: IDENTITY & UI ACTIONS SHOTS ===

    for (const vp of viewports) {
      // 21. Login pending state
      await takeShot({
        filename: `21-login-pending-${vp.name}.png`,
        screen: 'login-pending',
        state: 'pending',
        url: `${BASE_URL}/login/pending`,
        vp,
        setupFn: async (page) => {
          await page.goto(`${BASE_URL}/login/pending`, { waitUntil: 'domcontentloaded' });
          await page.waitForSelector('h1:has-text("Ожидание входа через Discord")');
        },
        desc: 'Ожидание Discord OAuth: пульсирующий индикатор и кнопка повторного открытия',
      });

      // 22. Login denied state
      await takeShot({
        filename: `22-login-denied-${vp.name}.png`,
        screen: 'login-denied',
        state: 'denied',
        url: `${BASE_URL}/login/denied`,
        vp,
        setupFn: async (page) => {
          await page.goto(`${BASE_URL}/login/denied`, { waitUntil: 'domcontentloaded' });
          await page.waitForSelector('h1:has-text("Доступ по приглашению")');
        },
        desc: 'Отказ во входе без инвайта: форма ввода кода и смена аккаунта',
      });

      // 23. Login error state
      await takeShot({
        filename: `23-login-error-${vp.name}.png`,
        screen: 'login-error',
        state: 'error',
        url: `${BASE_URL}/login/error?code=access_denied`,
        vp,
        setupFn: async (page) => {
          await page.goto(`${BASE_URL}/login/error?code=access_denied`, { waitUntil: 'domcontentloaded' });
          await page.waitForSelector('h1:has-text("Ошибка авторизации")');
        },
        desc: 'Экран ошибки авторизации с кодом ошибки и понятным разъяснением',
      });

      // 24. Onboarding Step 1
      await takeShot({
        filename: `24-onboarding-step1-${vp.name}.png`,
        screen: 'onboarding',
        state: 'step1',
        url: `${BASE_URL}/onboarding`,
        vp,
        setupFn: async (page) => {
          await page.goto(`${BASE_URL}/onboarding`, { waitUntil: 'domcontentloaded' });
          await page.waitForSelector('h1:has-text("Как к тебе обращаться?")');
        },
        desc: 'Онбординг (шаг 1): отображаемое имя и аватар с инициалами',
      });

      // 25. Onboarding Step 2
      await takeShot({
        filename: `25-onboarding-step2-${vp.name}.png`,
        screen: 'onboarding',
        state: 'step2',
        url: `${BASE_URL}/onboarding`,
        vp,
        setupFn: async (page) => {
          await page.goto(`${BASE_URL}/onboarding`, { waitUntil: 'domcontentloaded' });
          const nextBtn = await page.waitForSelector('button:has-text("Далее")');
          await nextBtn.click();
          await page.waitForSelector('h1:has-text("Что помнить?")');
        },
        desc: 'Онбординг (шаг 2): переключатели памяти и синхронизации внешних каналов',
      });
    }

    // 26. Settings Accounts tab
    await takeShot({
      filename: '26-settings-accounts-1440.png',
      screen: 'settings',
      state: 'accounts',
      url: `${BASE_URL}/chat`,
      vp: { name: '1440', width: 1440, height: 900, isMobile: false },
      setupFn: async (page) => {
        await page.goto(`${BASE_URL}/chat`, { waitUntil: 'domcontentloaded' });
        const profileBtn = await page.waitForSelector('button:has-text("Администратор"), button:has-text("Алексей")', { state: 'visible' });
        await profileBtn.click();
        const settingsItem = await page.waitForSelector('[role="menuitem"]:has-text("Настройки")', { state: 'visible' });
        await settingsItem.click();
        await page.waitForSelector('[role="dialog"][aria-modal="true"]');
        const accTab = await page.waitForSelector('[role="dialog"] button:has-text("Привязанные аккаунты"), [role="dialog"] button:has-text("Аккаунты")');
        await accTab.click();
        await page.waitForTimeout(400);
      },
      desc: 'Настройки: привязанные аккаунты (Discord, Web email, Telegram заглушка)',
    });

    // 27. Settings Merge Modal
    await takeShot({
      filename: '27-settings-merge-modal-1440.png',
      screen: 'settings',
      state: 'merge-modal',
      url: `${BASE_URL}/chat`,
      vp: { name: '1440', width: 1440, height: 900, isMobile: false },
      setupFn: async (page) => {
        await page.goto(`${BASE_URL}/chat`, { waitUntil: 'domcontentloaded' });
        const profileBtn = await page.waitForSelector('button:has-text("Администратор"), button:has-text("Алексей")', { state: 'visible' });
        await profileBtn.click();
        const settingsItem = await page.waitForSelector('[role="menuitem"]:has-text("Настройки")', { state: 'visible' });
        await settingsItem.click();
        const accTab = await page.waitForSelector('[role="dialog"] button:has-text("Привязанные аккаунты"), [role="dialog"] button:has-text("Аккаунты")');
        await accTab.click();
        const mergeBtn = await page.waitForSelector('button:has-text("Объединить с другим")');
        await mergeBtn.click();
        await page.waitForSelector('h2:has-text("Объединение профилей Neyra")');
        await page.waitForSelector('button:has-text("Закрыть")');
        await page.waitForTimeout(400);
      },
      desc: 'Настройки: модальное окно объединения профилей с предпросмотром данных',
    });

    // 28. Admin Access Invites Table
    await takeShot({
      filename: '28-admin-access-invites-1440.png',
      screen: 'admin-access',
      state: 'invites',
      url: `${BASE_URL}/chat`,
      vp: { name: '1440', width: 1440, height: 900, isMobile: false },
      setupFn: async (page) => {
        await page.goto(`${BASE_URL}/chat`, { waitUntil: 'domcontentloaded' });
        await openAdminDialog(page, { isMobile: false });
        await clickAdminTab(page, 'Доступ', false);
        const invitesTab = await page.waitForSelector('[role="dialog"] button:has-text("Приглашения")');
        await invitesTab.click();
        const genBtn = await page.waitForSelector('[role="dialog"] button:has-text("Сгенерировать ссылку")');
        await genBtn.click();
        await page.waitForSelector('span:has-text("Инвайт успешно создан")');
        await page.waitForTimeout(400);
      },
      desc: 'Админка: таблица инвайтов с созданным кодом, сроком, ссылкой и отзывом',
    });

    // 29. Admin Person Merge Modal
    await takeShot({
      filename: '29-admin-person-merge-1440.png',
      screen: 'admin-access',
      state: 'person-merge',
      url: `${BASE_URL}/chat`,
      vp: { name: '1440', width: 1440, height: 900, isMobile: false },
      setupFn: async (page) => {
        await page.goto(`${BASE_URL}/chat`, { waitUntil: 'domcontentloaded' });
        await openAdminDialog(page, { isMobile: false });
        await clickAdminTab(page, 'Доступ', false);
        const mergeBtn = await page.waitForSelector('[role="dialog"] button:has-text("Объединить с…")');
        await mergeBtn.click();
        await page.waitForSelector('h3:has-text("Объединение профиля")');
        await page.waitForSelector('button:has-text("Закрыть")');
        await page.waitForTimeout(400);
      },
      desc: 'Админка: модальное окно объединения двух person_id с требованием слова «объединить»',
    });

    // 30. Context Menu: Message
    await takeShot({
      filename: '30-context-menu-message-1440.png',
      screen: 'context-menu',
      state: 'message',
      url: `${BASE_URL}/chat`,
      vp: { name: '1440', width: 1440, height: 900, isMobile: false },
      setupFn: async (page) => {
        await page.goto(`${BASE_URL}/chat`, { waitUntil: 'domcontentloaded' });
        const textarea = await page.waitForSelector('textarea[aria-label="Сообщение"]');
        await textarea.fill('Тестовое сообщение для контекстного меню');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(600);
        const msg = await page.waitForSelector('[data-context="chat-message"]');
        await msg.click({ button: 'right' });
        await page.waitForSelector('[role="menu"][aria-label="Контекстное меню"]');
        await page.waitForTimeout(300);
      },
      desc: 'Контекстное меню (ПКМ) сообщения: копирование, редактирование, озвучка (скоро), удаление',
    });

    // 31. Context Menu: Sidebar Chat Item
    await takeShot({
      filename: '31-context-menu-sidebar-chat-1440.png',
      screen: 'context-menu',
      state: 'sidebar-chat',
      url: `${BASE_URL}/chat`,
      vp: { name: '1440', width: 1440, height: 900, isMobile: false },
      setupFn: async (page) => {
        await page.goto(`${BASE_URL}/chat`, { waitUntil: 'domcontentloaded' });
        const textarea = await page.waitForSelector('textarea[aria-label="Сообщение"]');
        await textarea.fill('Тестовый диалог для меню');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(600);
        const chatItem = await page.waitForSelector('[data-context="chat-item"]');
        await chatItem.click({ button: 'right' });
        await page.waitForSelector('[role="menu"][aria-label="Контекстное меню"]');
        await page.waitForTimeout(300);
      },
      desc: 'Контекстное меню (ПКМ) диалога в сайдбаре: переименовать, закрепить, экспорт, копировать ID',
    });

    // 32. Context Menu: Invite Row in Admin
    await takeShot({
      filename: '32-context-menu-invite-row-1440.png',
      screen: 'context-menu',
      state: 'invite-row',
      url: `${BASE_URL}/chat`,
      vp: { name: '1440', width: 1440, height: 900, isMobile: false },
      setupFn: async (page) => {
        await page.goto(`${BASE_URL}/chat`, { waitUntil: 'domcontentloaded' });
        await openAdminDialog(page, { isMobile: false });
        await clickAdminTab(page, 'Доступ', false);
        const invitesTab = await page.waitForSelector('[role="dialog"] button:has-text("Приглашения")');
        await invitesTab.click();
        const genBtn = await page.waitForSelector('[role="dialog"] button:has-text("Сгенерировать ссылку")');
        await genBtn.click();
        await page.waitForTimeout(800);
        const row = await page.waitForSelector('[data-context="invite-row"]');
        await row.click({ button: 'right' });
        await page.waitForSelector('[role="menu"][aria-label="Контекстное меню"]');
        await page.waitForTimeout(300);
      },
      desc: 'Контекстное меню (ПКМ) инвайта в админке: копирование кода, ссылки, отзыв',
    });

    // 33. Context Menu: Admin User Row
    await takeShot({
      filename: '33-context-menu-admin-row-1440.png',
      screen: 'context-menu',
      state: 'admin-row',
      url: `${BASE_URL}/chat`,
      vp: { name: '1440', width: 1440, height: 900, isMobile: false },
      setupFn: async (page) => {
        await page.goto(`${BASE_URL}/chat`, { waitUntil: 'domcontentloaded' });
        await openAdminDialog(page, { isMobile: false });
        await clickAdminTab(page, 'Доступ', false);
        const row = await page.waitForSelector('[data-context="admin-row"]');
        await row.click({ button: 'right' });
        await page.waitForSelector('[role="menu"][aria-label="Контекстное меню"]');
        await page.waitForTimeout(300);
      },
      desc: 'Контекстное меню (ПКМ) пользователя в админке: объединение, person_id, роль, бан, вход как',
    });

    // 34. Context Menu: Link
    await takeShot({
      filename: '34-context-menu-link-1440.png',
      screen: 'context-menu',
      state: 'link',
      url: `${BASE_URL}/login`,
      vp: { name: '1440', width: 1440, height: 900, isMobile: false },
      setupFn: async (page) => {
        await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded' });
        const link = await page.waitForSelector('a[href="/api/health"]');
        await link.click({ button: 'right' });
        await page.waitForSelector('[role="menu"][aria-label="Контекстное меню"]');
        await page.waitForTimeout(300);
      },
      desc: 'Контекстное меню (ПКМ) ссылки: копировать адрес ссылки, открыть в новой вкладке',
    });

    // 35. Context Menu: Mobile 390
    await takeShot({
      filename: '35-context-menu-mobile-390.png',
      screen: 'context-menu',
      state: 'mobile-touch',
      url: `${BASE_URL}/chat`,
      vp: { name: '390', width: 390, height: 844, isMobile: true, hasTouch: true },
      setupFn: async (page) => {
        await page.goto(`${BASE_URL}/chat`, { waitUntil: 'domcontentloaded' });
        const header = await page.waitForSelector('[data-context="thread-header"]');
        const box = await header.boundingBox();
        if (box) {
          await page.evaluate(({ x, y }) => {
            const el = document.elementFromPoint(x, y);
            if (el) {
              const touch = new Touch({ identifier: 1, target: el, clientX: x, clientY: y, pageX: x, pageY: y });
              el.dispatchEvent(new TouchEvent('touchstart', { touches: [touch], targetTouches: [touch], changedTouches: [touch], bubbles: true }));
            }
          }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
          await page.waitForTimeout(650);
        }
        await page.waitForSelector('[role="menu"][aria-label="Контекстное меню"]');
      },
      desc: 'Мобильное контекстное меню (390px): длинное нажатие (long-press 500ms) с тактильной адаптацией',
    });

    // 36. OpenCode CLI Command Modal
    await takeShot({
      filename: '36-admin-providers-opencode-cli-1440.png',
      screen: 'admin-providers',
      state: 'cli-modal',
      url: `${BASE_URL}/chat`,
      vp: { name: '1440', width: 1440, height: 900, isMobile: false },
      setupFn: async (page) => {
        await page.goto(`${BASE_URL}/chat`, { waitUntil: 'domcontentloaded' });
        await openAdminDialog(page, { isMobile: false });
        await clickAdminTab(page, 'Провайдеры', false);
        const cliBtn = await page.waitForSelector('button:has-text("Авторизация в терминале"), button:has-text("Инструкция")');
        await cliBtn.click();
        await page.waitForSelector('[role="dialog"][aria-label*="OpenCode"]');
        await page.waitForTimeout(300);
      },
      desc: 'Провайдеры: модальное окно с инструкцией подключения OpenCode CLI и копированием команды',
    });

    // 37. Dedicated Provider Screen
    await takeShot({
      filename: '37-admin-provider-detail-1440.png',
      screen: 'admin-providers',
      state: 'provider-detail',
      url: `${BASE_URL}/chat`,
      vp: { name: '1440', width: 1440, height: 900, isMobile: false },
      setupFn: async (page) => {
        await page.goto(`${BASE_URL}/chat`, { waitUntil: 'domcontentloaded' });
        await openAdminDialog(page, { isMobile: false });
        await clickAdminTab(page, 'Провайдеры', false);
        const providerCard = await page.waitForSelector('[data-provider-card="openai"], [data-provider-card]');
        await providerCard.click();
        await page.waitForSelector('button:has-text("Назад к списку")');
        await page.waitForTimeout(400);
      },
      desc: 'Провайдеры: выделенный экран провайдера (OpenAI) с разделами подключения, ключа, моделей, лейнов и опасной зоны',
    });

    // 38. Add Provider Modal (Step 1 Presets)
    await takeShot({
      filename: '38-admin-add-provider-modal-1440.png',
      screen: 'admin-providers',
      state: 'add-modal',
      url: `${BASE_URL}/chat`,
      vp: { name: '1440', width: 1440, height: 900, isMobile: false },
      setupFn: async (page) => {
        await page.goto(`${BASE_URL}/chat`, { waitUntil: 'domcontentloaded' });
        await openAdminDialog(page, { isMobile: false });
        await clickAdminTab(page, 'Провайдеры', false);
        const addBtn = await page.waitForSelector('button:has-text("Добавить провайдера")');
        await addBtn.click();
        await page.waitForSelector('[role="dialog"][aria-label="Добавить провайдера"]');
        await page.waitForTimeout(300);
      },
      desc: 'Провайдеры: двухшаговая модалка добавления провайдера с каталогом пресетов',
    });

    // 39. Channels Settings Modal
    await takeShot({
      filename: '39-channels-settings-modal-1440.png',
      screen: 'channels',
      state: 'settings-modal',
      url: `${BASE_URL}/channels`,
      vp: { name: '1440', width: 1440, height: 900, isMobile: false },
      setupFn: async (page) => {
        await page.goto(`${BASE_URL}/channels`, { waitUntil: 'domcontentloaded' });
        const profileBtn = await page.waitForSelector('button[aria-label="Меню профиля пользователя"], button:has-text("Администратор")', { state: 'visible' });
        await profileBtn.click();
        await page.waitForTimeout(300);
        const settingsItem = await page.waitForSelector('[role="menuitem"]:has-text("Настройки")', { state: 'visible' });
        await settingsItem.click();
        await page.waitForSelector('[role="dialog"][aria-modal="true"]');
        await page.waitForTimeout(400);
      },
      desc: 'Каналы: вызов модалки настроек прямо из интерфейса /channels без перехода на страницу',
    });

    // 40. Chat Settings URL Query Parameter
    await takeShot({
      filename: '40-chat-settings-param-1440.png',
      screen: 'chat',
      state: 'query-param-settings',
      url: `${BASE_URL}/chat?settings=1`,
      vp: { name: '1440', width: 1440, height: 900, isMobile: false },
      setupFn: async (page) => {
        await page.goto(`${BASE_URL}/chat?settings=1`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('[role="dialog"][aria-modal="true"]');
        await page.waitForTimeout(400);
      },
      desc: 'Чат: автоматическое открытие модалки настроек по URL-параметру ?settings=1 (легаси-редирект с /settings)',
    });

    // Write manifest.json
    const manifest = {
      commit,
      baseCommit: '8bdbf5eb4f0e928071f2d5b2fbd0cb0527936ccd',
      generatedAt: new Date().toISOString(),
      nodeVersion: process.version,
      totalScreenshots: manifestItems.length,
      screenshots: manifestItems,
    };

    const manifestPath = join(outDir, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(`\n[ui-shots] SUCCESS: Captured ${manifestItems.length} unique screenshots.`);
    console.log(`[ui-shots] Manifest written to ${manifestPath}`);

  } finally {
    if (browser) await browser.close();
    if (serverProcess) serverProcess.kill();
  }
}

main().catch((err) => {
  console.error('\n[ui-shots] ERROR:', err);
  process.exit(1);
});
