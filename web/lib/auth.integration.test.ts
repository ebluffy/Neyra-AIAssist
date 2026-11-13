// AR-6: вход и роли на настоящем PostgreSQL (включается только в CI job с AUTH_INTEGRATION_DATABASE_URL).
// Покрывает: регистрацию, вход, getSession, роль user, повторный email, выход,
// admin:grant/--revoke, rate limit по IP (попытка N+1 → 429) и счётчик неудачных
// входов по аккаунту (AR-4). Без сети: auth.handler вызывается в процессе.
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RUN = Boolean(process.env.AUTH_INTEGRATION_DATABASE_URL);
const BASE = 'http://localhost:3000';

function uniqueEmail(tag: string): string {
  return `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`.toLowerCase();
}

async function call(path: string, body: Record<string, unknown>, cookie?: string, ip = '203.0.113.10') {
  const { getAuth } = await import('./auth');
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-real-ip': ip };
  if (cookie) headers.cookie = cookie;
  const response = await getAuth().handler(new Request(`${BASE}/api/auth${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  }));
  const setCookie = response.headers.get('set-cookie') ?? undefined;
  return { response, setCookie, json: await response.json().catch(() => null) };
}

async function getSession(cookie: string) {
  const { getAuth } = await import('./auth');
  const response = await getAuth().handler(new Request(`${BASE}/api/auth/get-session`, {
    method: 'GET',
    headers: { cookie, 'x-real-ip': '203.0.113.10' },
  }));
  return { response, json: await response.json().catch(() => null) };
}

function grant(email: string, revoke = false): string {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  return execFileSync(process.execPath, [
    join(root, 'web/scripts/grant-admin.mjs'), email, ...(revoke ? ['--revoke'] : []),
  ], { env: { ...process.env }, encoding: 'utf-8' }).trim();
}

describe.skipIf(!RUN)('auth flow on real PostgreSQL 16 (AR-6)', () => {
  const password = 'correct-horse-22';

  it('signup → session → user role → duplicate email → sign-out → sign-in → grant/revoke', async () => {
    const email = uniqueEmail('flow');
    const up = await call('/sign-up/email', { email, password, name: 'CI User' });
    expect(up.response.status, `signup: ${JSON.stringify(up.json)}`).toBe(200);
    expect(up.setCookie).toBeTruthy();
    const cookie = up.setCookie!.split(';')[0];

    const session = await getSession(cookie);
    expect(session.response.status).toBe(200);
    expect(session.json.user.email).toBe(email);
    expect(session.json.user.role).toBe('user');

    const dup = await call('/sign-up/email', { email, password, name: 'CI User' });
    expect(dup.response.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(dup.json)).toContain('USER_ALREADY_EXISTS');

    const out = await call('/sign-out', {}, cookie);
    expect(out.response.status).toBe(200);
    const afterOut = await getSession(cookie);
    expect(afterOut.json?.user ?? null).toBeNull();

    const backIn = await call('/sign-in/email', { email, password });
    expect(backIn.response.status, `sign-in: ${JSON.stringify(backIn.json)}`).toBe(200);
    const role = await getSession(backIn.setCookie!.split(';')[0]);
    expect(role.json.user.role).toBe('user');

    expect(grant(email)).toContain('admin');
    expect((await getSession(backIn.setCookie!.split(';')[0])).json.user.role).toBe('admin');

    expect(grant(email, true)).toContain('user');
    expect((await getSession(backIn.setCookie!.split(';')[0])).json.user.role).toBe('user');
  });

  it('IP rate limit: попытка N+1 с того же адреса даёт 429 (AR-4)', async () => {
    // Каждая попытка — свой аккаунт (по одной неудаче на счётчике),
    // чтобы сработало именно правило по IP, а не счётчик по аккаунту.
    // Регистрации идут с разных адресов: на /sign-up/email действует
    // собственный лимит 5/мин на IP.
    for (let attempt = 1; attempt <= 5; attempt++) {
      const email = uniqueEmail(`ip-${attempt}`);
      const up = await call('/sign-up/email', { email, password, name: 'IP' }, undefined, `198.51.100.${10 + attempt}`);
      expect(up.response.status).toBe(200);
      const r = await call('/sign-in/email', { email, password: 'wrong-password' }, undefined, '198.51.100.1');
      expect(r.response.status, `attempt ${attempt}`).toBe(401);
    }
    const sixthEmail = uniqueEmail('ip-6');
    const sixthUp = await call('/sign-up/email', { email: sixthEmail, password, name: 'IP' }, undefined, '198.51.100.20');
    expect(sixthUp.response.status).toBe(200);
    const sixth = await call('/sign-in/email', { email: sixthEmail, password: 'wrong-password' }, undefined, '198.51.100.1');
    expect(sixth.response.status).toBe(429);
    // Другой адрес снова получает честный ответ, а не блокировку чужого счётчика.
    const other = await call('/sign-in/email', { email: sixthEmail, password: 'wrong-password' }, undefined, '198.51.100.2');
    expect(other.response.status).toBe(401);
  });

  it('счётчик по аккаунту: после 5 неудач с разных IP вход блокируется для этого email (AR-4)', async () => {
    const email = uniqueEmail('acct-limit');
    const up = await call('/sign-up/email', { email, password, name: 'Acct' }, undefined, '192.0.2.1');
    expect(up.response.status).toBe(200);
    for (let attempt = 1; attempt <= 5; attempt++) {
      const r = await call('/sign-in/email', { email, password: 'wrong-password' }, undefined, `192.0.2.${attempt}`);
      expect(r.response.status, `failure ${attempt}`).toBe(401);
    }
    // Шестая неудача с нового IP: лимит по аккаунту, а не по адресу.
    const sixth = await call('/sign-in/email', { email, password: 'wrong-password' }, undefined, '192.0.2.99');
    expect(sixth.response.status).toBe(429);
    // Другой аккаунт с того же адреса не затронт.
    const other = uniqueEmail('acct-other');
    const otherUp = await call('/sign-up/email', { email: other, password, name: 'Other' }, undefined, '192.0.2.99');
    expect(otherUp.response.status).toBe(200);
    const otherTry = await call('/sign-in/email', { email: other, password: 'wrong-password' }, undefined, '192.0.2.99');
    expect(otherTry.response.status).toBe(401);
  });

  afterAll(async () => {
    const { getDatabase } = await import('./db');
    await getDatabase().pool.end().catch(() => {});
  });
});
