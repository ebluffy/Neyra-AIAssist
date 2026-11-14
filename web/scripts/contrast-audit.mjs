#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
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

async function ensureStaticAssets() {
  const staticSrc = join(webDir, '.next/static');
  const staticDest = join(webDir, '.next/standalone/web/.next/static');
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

// WCAG relative luminance & contrast algorithms
function srgbToLinear(c) {
  const norm = c / 255;
  return norm <= 0.04045 ? norm / 12.92 : Math.pow((norm + 0.055) / 1.055, 2.4);
}

function relativeLuminance(r, g, b) {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

function contrastRatio(lum1, lum2) {
  const lighter = Math.max(lum1, lum2);
  const darker = Math.min(lum1, lum2);
  return (lighter + 0.05) / (darker + 0.05);
}

function parseColor(str) {
  if (!str) return null;
  const mRgba = str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
  if (mRgba) {
    return {
      r: parseInt(mRgba[1], 10),
      g: parseInt(mRgba[2], 10),
      b: parseInt(mRgba[3], 10),
      a: mRgba[4] !== undefined ? parseFloat(mRgba[4]) : 1.0,
    };
  }
  const mHex = str.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
  if (mHex) {
    return {
      r: parseInt(mHex[1], 16),
      g: parseInt(mHex[2], 16),
      b: parseInt(mHex[3], 16),
      a: 1.0,
    };
  }
  return null;
}

// Composite foreground RGBA over background RGB
function blendRgbaOverRgb(fg, bg) {
  const a = fg.a;
  return {
    r: Math.round(fg.r * a + bg.r * (1 - a)),
    g: Math.round(fg.g * a + bg.g * (1 - a)),
    b: Math.round(fg.b * a + bg.b * (1 - a)),
    a: 1.0,
  };
}

async function isServerReady() {
  try {
    const res = await fetch(`${BASE_URL}/login`, { signal: AbortSignal.timeout(1500) });
    return res.status === 200;
  } catch {
    return false;
  }
}

async function startServer() {
  await ensureStaticAssets();

  if (await isServerReady()) {
    console.log(`[contrast-audit] Server already active on ${BASE_URL}`);
    return null;
  }

  console.log(`[contrast-audit] Starting server on ${BASE_URL}...`);
  const serverJs = join(webDir, '.next/standalone/web/server.js');
  if (!existsSync(serverJs)) {
    throw new Error(`Server script not found at ${serverJs}. Build project first.`);
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

  const start = Date.now();
  while (Date.now() - start < 15000) {
    if (await isServerReady()) {
      console.log(`[contrast-audit] Server ready on ${BASE_URL}`);
      return child;
    }
    await new Promise(r => setTimeout(r, 200));
  }
  child.kill();
  throw new Error('[contrast-audit] Server timeout.');
}

async function loginAdmin() {
  console.log('[contrast-audit] Authenticating test admin...');
  const res = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE_URL },
    body: JSON.stringify({ email: 'admin@neyra.local', password: 'Password1234!' }),
  });
  if (!res.ok) throw new Error(`Auth failed: ${res.status}`);
  const setCookie = res.headers.get('set-cookie') || '';
  const match = setCookie.match(/better-auth\.session_token=([^;]+)/);
  if (!match) throw new Error('Session cookie not found');
  return match[1];
}

async function main() {
  console.log('=== WCAG 2.2 Programmatic Contrast Audit ===');
  let serverProcess = null;
  let browser = null;

  try {
    serverProcess = await startServer();
    const sessionToken = await loginAdmin();

    browser = await chromium.launch({
      executablePath: CHROMIUM_PATH,
      args: ['--no-sandbox', '--disable-gpu'],
    });

    const results = [];

    async function evaluatePair(page, { surface, element, role, fgSelector, reqRatio, type = 'text' }) {
      const loc = page.locator(fgSelector).first();
      const count = await loc.count();
      if (count === 0) {
        console.warn(`[WARN] Element not found: ${fgSelector}`);
        return null;
      }

      const computed = await loc.evaluate((fgEl, type) => {
        function getActualBg(el) {
          let cur = el;
          while (cur) {
            const style = window.getComputedStyle(cur);
            const bg = style.backgroundColor;
            if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
              return bg;
            }
            cur = cur.parentElement;
          }
          return 'rgb(0, 0, 0)';
        }

        const fgStyle = window.getComputedStyle(fgEl);
        const fgColor = type === 'border' ? fgStyle.borderColor : fgStyle.color;
        const bgColor = getActualBg(fgEl.parentElement || fgEl);

        return { fgColor, bgColor };
      }, type);

      const fgRaw = parseColor(computed.fgColor);
      let bgRaw = parseColor(computed.bgColor);
      if (!fgRaw || !bgRaw) {
        console.warn(`[WARN] Unparsable color: fg=${computed.fgColor}, bg=${computed.bgColor}`);
        return null;
      }

      if (bgRaw.a < 1.0) {
        bgRaw = blendRgbaOverRgb(bgRaw, { r: 0, g: 0, b: 0, a: 1.0 });
      }

      let effectiveFg = fgRaw;
      if (fgRaw.a < 1.0) {
        effectiveFg = blendRgbaOverRgb(fgRaw, bgRaw);
      }

      const lumFg = relativeLuminance(effectiveFg.r, effectiveFg.g, effectiveFg.b);
      const lumBg = relativeLuminance(bgRaw.r, bgRaw.g, bgRaw.b);
      const ratio = contrastRatio(lumFg, lumBg);
      const passed = ratio >= reqRatio;

      const record = {
        surface,
        element,
        role,
        type,
        fgColor: computed.fgColor,
        bgColor: computed.bgColor,
        blendedFg: `rgb(${effectiveFg.r}, ${effectiveFg.g}, ${effectiveFg.b})`,
        blendedBg: `rgb(${bgRaw.r}, ${bgRaw.g}, ${bgRaw.b})`,
        ratio: Number(ratio.toFixed(2)),
        required: reqRatio,
        passed,
      };

      console.log('[DEBUG]', record.element, 'fg:', computed.fgColor, 'bg:', computed.bgColor, 'blendedFg:', record.blendedFg, 'blendedBg:', record.blendedBg, 'ratio:', record.ratio);
      results.push(record);
      return record;
    }

    // 1. Audit /login (anonymous context)
    console.log('[contrast-audit] Inspecting /login...');
    const anonContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
    const anonPage = await anonContext.newPage();
    await anonPage.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle' });

    // Email input border
    await evaluatePair(anonPage, {
      surface: 'Auth Card (--surface)',
      element: 'Input Field (Email)',
      role: 'SC 1.4.11 Control Boundary',
      fgSelector: 'input[name="email"]',
      reqRatio: 3.0,
      type: 'border',
    });

    // Email input text
    await anonPage.fill('input[name="email"]', 'test@example.com');
    await evaluatePair(anonPage, {
      surface: 'Input Surface (--surface-2)',
      element: 'Input Typed Text',
      role: 'SC 1.4.3 Normal Text',
      fgSelector: 'input[name="email"]',
      reqRatio: 4.5,
      type: 'text',
    });

    // Primary button
    await anonPage.evaluate(() => {
      const btn = document.querySelector('button[type="submit"]');
      const bg = window.getComputedStyle(btn).backgroundColor;
      const color = window.getComputedStyle(btn).color;
      return { bg, color };
    }).then(res => {
      const fg = parseColor(res.color);
      const bg = parseColor(res.bg);
      const lumFg = relativeLuminance(fg.r, fg.g, fg.b);
      const lumBg = relativeLuminance(bg.r, bg.g, bg.b);
      const ratio = contrastRatio(lumFg, lumBg);
      results.push({
        surface: 'Accent Button (--accent)',
        element: 'Primary Button Label',
        role: 'SC 1.4.3 Normal Text',
        type: 'text',
        fgColor: res.color,
        bgColor: res.bg,
        blendedFg: res.color,
        blendedBg: res.bg,
        ratio: Number(ratio.toFixed(2)),
        required: 4.5,
        passed: ratio >= 4.5,
      });
    });

    // Secondary / Discord button border & text
    await evaluatePair(anonPage, {
      surface: 'Auth Card (--surface)',
      element: 'Discord Button',
      role: 'SC 1.4.3 Normal Text',
      fgSelector: 'button:has-text("Продолжить с Discord"), button:has-text("Войти через Discord")',
      reqRatio: 4.5,
      type: 'text',
    });

    // Trigger error state on /login
    await anonPage.fill('input[name="email"]', 'invalid@example.com');
    await anonPage.fill('input[name="password"]', 'wrongpass');
    await anonPage.click('button[type="submit"]');
    await anonPage.waitForSelector('[role="alert"]', { timeout: 5000 }).catch(() => null);

    const alertEl = await anonPage.$('[role="alert"]');
    if (alertEl) {
      await evaluatePair(anonPage, {
        surface: 'Danger Quiet Banner',
        element: 'Alert Error Text',
        role: 'SC 1.4.3 Normal Text',
        fgSelector: '[role="alert"]',
        reqRatio: 4.5,
        type: 'text',
      });
    }
    await anonContext.close();

    // 2. Audit /chat (authenticated context)
    console.log('[contrast-audit] Inspecting /chat...');
    const authContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
    await authContext.addCookies([
      { name: 'better-auth.session_token', value: sessionToken, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' },
    ]);
    const authPage = await authContext.newPage();
    await authPage.goto(`${BASE_URL}/chat`, { waitUntil: 'networkidle' });

    // Body / Main text
    await evaluatePair(authPage, {
      surface: 'Base Canvas (--bg)',
      element: 'Empty State Headline',
      role: 'SC 1.4.3 Large Text',
      fgSelector: 'h2, h1',
      reqRatio: 3.0,
      type: 'text',
    });

    // Chip border
    await evaluatePair(authPage, {
      surface: 'Chat Empty Canvas',
      element: 'Scenario Chip',
      role: 'SC 1.4.11 Control Boundary',
      fgSelector: 'button:has-text("Что нового в памяти?")',
      reqRatio: 3.0,
      type: 'border',
    });

    // Chat Composer Textarea border
    await evaluatePair(authPage, {
      surface: 'Chat Canvas (--bg)',
      element: 'Composer Input Box',
      role: 'SC 1.4.11 Control Boundary',
      fgSelector: 'textarea',
      reqRatio: 3.0,
      type: 'border',
    });

    // Subtitle / text-subtle
    await evaluatePair(authPage, {
      surface: 'Chat Canvas (--bg)',
      element: 'Footer Subtle Note',
      role: 'SC 1.4.3 Normal Text',
      fgSelector: 'footer, p.text-\\[var\\(--text-subtle\\)\\]',
      reqRatio: 4.5,
      type: 'text',
    }).catch(() => null);

    // 3. Open Admin Dialog
    console.log('[contrast-audit] Inspecting Admin Dialog...');
    const adminBtnDirect = await authPage.$('button[aria-label="Админ-панель"]');
    if (adminBtnDirect && (await adminBtnDirect.isVisible())) {
      await adminBtnDirect.click();
    } else {
      const profileBtn = await authPage.waitForSelector(
        'button[aria-label="Меню профиля пользователя"], button:has-text("Администратор"), button:has-text("Алексей")',
        { state: 'visible' },
      );
      await profileBtn.click();
      await authPage.waitForTimeout(300);
      const adminItem = await authPage.waitForSelector(
        'button:has-text("Админ-панель"), [role="menuitem"]:has-text("Админ-панель")',
        { state: 'visible' },
      );
      await adminItem.click();
    }
    await authPage.waitForSelector('[role="dialog"][aria-modal="true"]', { state: 'visible' });

      // Admin search input border
      await authPage.click('aside[aria-label="Разделы админки"] button:has-text("Доступ")');
      await authPage.waitForTimeout(400);

      await evaluatePair(authPage, {
        surface: 'Admin Modal Surface',
        element: 'Admin User Search Input',
        role: 'SC 1.4.11 Control Boundary',
        fgSelector: '[role="dialog"] input[placeholder*="Поиск"]',
        reqRatio: 3.0,
        type: 'border',
      });

      // Radio indicator inactive border
      await evaluatePair(authPage, {
        surface: 'Admin Radio Card (--surface-2)',
        element: 'Radio Circle Indicator',
        role: 'SC 1.4.11 Graphical Object',
        fgSelector: 'button:has-text("Только по инвайтам") span.rounded-full',
        reqRatio: 3.0,
        type: 'border',
      });
    await authContext.close();

    // 4. Direct token matrix verification
    const tokenMatrix = [
      { surface: '--bg (#000000)', element: 'Body Text (--text #f4f4f5)', fg: { r: 244, g: 244, b: 245, a: 1 }, bg: { r: 0, g: 0, b: 0, a: 1 }, req: 4.5, role: 'SC 1.4.3 Normal Text' },
      { surface: '--surface-2 (#121212)', element: 'Panel Text (--text #f4f4f5)', fg: { r: 244, g: 244, b: 245, a: 1 }, bg: { r: 18, g: 18, b: 18, a: 1 }, req: 4.5, role: 'SC 1.4.3 Normal Text' },
      { surface: '--bg (#000000)', element: 'Muted Text (--text-muted #a1a1aa)', fg: { r: 161, g: 161, b: 170, a: 1 }, bg: { r: 0, g: 0, b: 0, a: 1 }, req: 4.5, role: 'SC 1.4.3 Normal Text' },
      { surface: '--surface-2 (#121212)', element: 'Muted Text (--text-muted #a1a1aa)', fg: { r: 161, g: 161, b: 170, a: 1 }, bg: { r: 18, g: 18, b: 18, a: 1 }, req: 4.5, role: 'SC 1.4.3 Normal Text' },
      { surface: '--bg (#000000)', element: 'Subtle Text (--text-subtle #8e8e99)', fg: { r: 142, g: 142, b: 153, a: 1 }, bg: { r: 0, g: 0, b: 0, a: 1 }, req: 4.5, role: 'SC 1.4.3 Normal Text' },
      { surface: '--surface-2 (#121212)', element: 'Subtle Text (--text-subtle #8e8e99)', fg: { r: 142, g: 142, b: 153, a: 1 }, bg: { r: 18, g: 18, b: 18, a: 1 }, req: 4.5, role: 'SC 1.4.3 Normal Text' },
      { surface: '--bg (#000000)', element: 'Control Border (--border-control rgba(255,255,255,0.36))', fg: { r: 255, g: 255, b: 255, a: 0.36 }, bg: { r: 0, g: 0, b: 0, a: 1 }, req: 3.0, role: 'SC 1.4.11 Control Boundary' },
      { surface: '--surface-2 (#121212)', element: 'Control Border (--border-control rgba(255,255,255,0.36))', fg: { r: 255, g: 255, b: 255, a: 0.36 }, bg: { r: 18, g: 18, b: 18, a: 1 }, req: 3.0, role: 'SC 1.4.11 Control Boundary' },
      { surface: '--surface-3 (#1a1a1a)', element: 'Control Border (--border-control rgba(255,255,255,0.36))', fg: { r: 255, g: 255, b: 255, a: 0.36 }, bg: { r: 26, g: 26, b: 26, a: 1 }, req: 3.0, role: 'SC 1.4.11 Control Boundary' },
      { surface: '--danger-quiet over --surface-2', element: 'Danger Text (--danger #f87171)', fg: { r: 248, g: 113, b: 113, a: 1 }, bg: blendRgbaOverRgb({ r: 239, g: 68, b: 68, a: 0.14 }, { r: 18, g: 18, b: 18, a: 1 }), req: 4.5, role: 'SC 1.4.3 Normal Text' },
    ];

    for (const t of tokenMatrix) {
      const blendedFg = t.fg.a < 1 ? blendRgbaOverRgb(t.fg, t.bg) : t.fg;
      const lumFg = relativeLuminance(blendedFg.r, blendedFg.g, blendedFg.b);
      const lumBg = relativeLuminance(t.bg.r, t.bg.g, t.bg.b);
      const cr = contrastRatio(lumFg, lumBg);
      results.push({
        surface: t.surface,
        element: t.element,
        role: t.role,
        type: t.req === 3.0 ? 'border' : 'text',
        fgColor: `rgba(${t.fg.r}, ${t.fg.g}, ${t.fg.b}, ${t.fg.a})`,
        bgColor: `rgb(${t.bg.r}, ${t.bg.g}, ${t.bg.b})`,
        blendedFg: `rgb(${blendedFg.r}, ${blendedFg.g}, ${blendedFg.b})`,
        blendedBg: `rgb(${t.bg.r}, ${t.bg.g}, ${t.bg.b})`,
        ratio: Number(cr.toFixed(2)),
        required: t.req,
        passed: cr >= t.req,
      });
    }

    console.log('\n=== Contrast Audit Results ===');
    console.table(
      results.map((r) => ({
        Element: r.element,
        Surface: r.surface,
        Role: r.role,
        Ratio: `${r.ratio}:1`,
        Required: `>= ${r.required}:1`,
        Verdict: r.passed ? 'PASS' : 'FAIL',
      }))
    );

    const outJson = join(webDir, 'docs', 'contrast.json');
    const summary = {
      auditedAt: new Date().toISOString(),
      standards: 'WCAG 2.2 AA (SC 1.4.3 >= 4.5:1, SC 1.4.11 >= 3.0:1)',
      totalChecked: results.length,
      passedCount: results.filter((r) => r.passed).length,
      failedCount: results.filter((r) => !r.passed).length,
      results,
    };

    mkdirSync(dirname(outJson), { recursive: true });
    writeFileSync(outJson, JSON.stringify(summary, null, 2), 'utf-8');
    console.log(`[contrast-audit] Saved results to ${outJson}`);

    if (summary.failedCount > 0) {
      console.error(`[contrast-audit] FAIL: ${summary.failedCount} element(s) failed WCAG contrast.`);
      process.exit(1);
    } else {
      console.log(`[contrast-audit] SUCCESS: All ${summary.totalChecked} pairs pass WCAG 2.2 standards.`);
    }
  } finally {
    if (browser) await browser.close();
    if (serverProcess) serverProcess.kill();
  }
}

main().catch((err) => {
  console.error('[contrast-audit] Fatal error:', err);
  process.exit(1);
});
