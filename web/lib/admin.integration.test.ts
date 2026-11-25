// Админ-панель на настоящем PostgreSQL (CI job db-verify).
// Без сети и внешних провайдеров: auth.handler и маршруты админки вызываются в процессе.
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { GET as listUsers } from '../src/app/api/admin/users/route';
import { PATCH as patchUser, DELETE as deleteUser } from '../src/app/api/admin/users/[id]/route';
import { POST as resetPasswordLink } from '../src/app/api/admin/users/[id]/reset-password/route';
import { GET as listInvites, POST as createInviteRoute } from '../src/app/api/admin/invites/route';
import { DELETE as revokeInviteRoute } from '../src/app/api/admin/invites/[id]/route';
import { GET as listLogs } from '../src/app/api/admin/logs/route';
import { GET as getCoreConfig, PUT as putCoreConfig } from '../src/app/api/admin/config/route';
import { GET as getLogTail } from '../src/app/api/admin/logs/tail/route';
import { GET as discordGuilds } from '../src/app/api/admin/discord/guilds/route';
import { GET as discordGuild } from '../src/app/api/admin/discord/guilds/[guildId]/route';
import { GET as discordMembers } from '../src/app/api/admin/discord/members/route';
import { GET as discordUserStats } from '../src/app/api/admin/discord/users/[personId]/stats/route';
import { GET as discordMessages } from '../src/app/api/admin/discord/messages/route';
import { GET as getSettings, PUT as putSettings } from '../src/app/api/admin/settings/route';

const TEST_DB_URL = process.env.AUTH_INTEGRATION_DATABASE_URL;
const RUN = Boolean(TEST_DB_URL);
// Тесты не должны случайно достучаться до боевой базы: все pg-соединения
// идут только на AUTH_INTEGRATION_DATABASE_URL, и auth получает её же.
if (TEST_DB_URL) process.env.DATABASE_URL = TEST_DB_URL;
const BASE = 'http://localhost:3000';

function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function uniqueEmail(tag: string): string {
  return `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`.toLowerCase();
}

function makeInvite(): string {
  const output = execFileSync(process.execPath, [join(repoRoot(), 'web/scripts/invite-create.mjs')],
    { env: { ...process.env, BETTER_AUTH_URL: BASE }, encoding: 'utf-8' });
  const match = output.match(/\/signup\?invite=(\S+)$/m);
  if (!match) throw new Error(`no invite in output: ${output}`);
  return match[1];
}

function grantAdmin(email: string): void {
  execFileSync(process.execPath, [join(repoRoot(), 'web/scripts/grant-admin.mjs'), email],
    { env: process.env, encoding: 'utf-8' });
}

let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `198.51.100.${(ipCounter % 200) + 20}`;
}

function cookieOf(response: Response): string {
  const raw = response.headers.get('set-cookie') ?? '';
  return raw.split(';')[0] ?? '';
}

async function authCall(path: string, body: Record<string, unknown>, cookie?: string) {
  const { getAuth } = await import('../lib/auth');
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-real-ip': nextIp() };
  if (cookie) headers.cookie = cookie;
  const response = await getAuth().handler(new Request(`${BASE}/api/auth${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  }));
  return { response, cookie: cookieOf(response), json: await response.json().catch(() => null) as Record<string, unknown> | null };
}

async function signUp(email: string, password: string) {
  return authCall('/sign-up/email', { email, password, name: email, invite: makeInvite() });
}

async function signIn(email: string, password: string) {
  return authCall('/sign-in/email', { email, password });
}

// AR-28: замер времени ответа на вход — бан не должен отвечать быстрее, чем
// настоящая ошибка пароля (иначе он виден по таймингу).
async function timedSignIn(email: string, password: string): Promise<number> {
  const started = performance.now();
  await signIn(email, password);
  return performance.now() - started;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function adminRequest(path: string, cookie?: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (cookie) headers.set('cookie', cookie);
  headers.set('content-type', 'application/json');
  return new Request(`${BASE}${path}`, { ...init, headers });
}

async function pgQuery(query: string, params: unknown[] = []) {
  const { Client } = await import('pg');
  const client = new Client({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    return await client.query(query, params);
  } finally {
    await client.end().catch(() => {});
  }
}

async function payloadOf(response: Response) {
  return response.json().catch(() => null) as Promise<{ ok?: boolean; data?: Record<string, unknown>; message?: string } | null>;
}

describe.skipIf(!RUN)('админ-панель на PostgreSQL', () => {
  const password = 'admin-test-password-1';
  const state: {
    adminEmail: string;
    adminId: string;
    adminCookie: string;
    memberId: string;
    memberEmail: string;
    memberCookie: string;
    memberPassword: string;
  } = {
    adminEmail: uniqueEmail('admin'),
    adminId: '',
    adminCookie: '',
    memberId: '',
    memberEmail: uniqueEmail('member'),
    memberCookie: '',
    memberPassword: 'member-test-password-1',
  };

  afterAll(async () => {
    const { getDatabase } = await import('../lib/db');
    await getDatabase().pool.end().catch(() => {});
  });

  it('готовит админа и обычного пользователя через инвайты', async () => {
    const adminSignUp = await signUp(state.adminEmail, password);
    expect(adminSignUp.response.status).toBe(200);
    grantAdmin(state.adminEmail);
    const adminLogin = await signIn(state.adminEmail, password);
    expect(adminLogin.response.status).toBe(200);
    state.adminCookie = adminLogin.cookie;
    state.adminId = String((adminLogin.json as { user?: { id?: string } } | null)?.user?.id ?? '');
    expect(state.adminCookie).toBeTruthy();

    const memberSignUp = await signUp(state.memberEmail, state.memberPassword);
    expect(memberSignUp.response.status).toBe(200);
    const memberLogin = await signIn(state.memberEmail, state.memberPassword);
    expect(memberLogin.response.status).toBe(200);
    state.memberCookie = memberLogin.cookie;
    state.memberId = String((memberLogin.json as { user?: { id?: string } } | null)?.user?.id ?? '');
    expect(state.memberId).toBeTruthy();
  });

  it('закрывает API от гостя и обычного пользователя', async () => {
    expect((await listUsers(adminRequest('/api/admin/users'))).status).toBe(401);
    expect((await listUsers(adminRequest('/api/admin/users', state.memberCookie))).status).toBe(403);
    expect((await createInviteRoute(adminRequest('/api/admin/invites', state.memberCookie, { method: 'POST', body: '{}' }))).status).toBe(403);
  });

  it('показывает список и меняет роль, не давая снять её с себя', async () => {
    const response = await listUsers(adminRequest('/api/admin/users?q=example.test&pageSize=50', state.adminCookie));
    expect(response.status).toBe(200);
    const payload = await payloadOf(response);
    const items = (payload?.data?.items ?? []) as Array<{ id: string; email: string; role: string }>;
    expect(items.some(item => item.email === state.adminEmail)).toBe(true);
    expect(items.some(item => item.email === state.memberEmail)).toBe(true);
    const member = items.find(item => item.email === state.memberEmail)!;

    const promote = await patchUser(adminRequest(`/api/admin/users/${member.id}`, state.adminCookie, {
      method: 'PATCH',
      body: JSON.stringify({ role: 'admin' }),
    }), { params: Promise.resolve({ id: member.id }) });
    expect(promote.status).toBe(200);

    const demote = await patchUser(adminRequest(`/api/admin/users/${member.id}`, state.adminCookie, {
      method: 'PATCH',
      body: JSON.stringify({ role: 'user' }),
    }), { params: Promise.resolve({ id: member.id }) });
    expect(demote.status).toBe(200);

    const self = await patchUser(adminRequest(`/api/admin/users/${state.adminId}`, state.adminCookie, {
      method: 'PATCH',
      body: JSON.stringify({ role: 'user' }),
    }), { params: Promise.resolve({ id: state.adminId }) });
    expect(self.status).toBe(409);
  });

  it('блокирует вход и удаляет живые сессии', async () => {
    // Ответ на настоящий неверный пароль — эталон для AR-28.
    const wrong = await signIn(state.memberEmail, 'definitely-wrong-password');
    expect(wrong.response.status).toBe(401);
    // AR-28: время ответа не должно выдавать бан. Ранний отказ до проверки
    // пароля отвечает за единицы миллисекунд, а обычный вход сначала хеширует
    // пароль (scrypt), поэтому сравниваем медианы на прогретом прогоне.
    const wrongTimes = [
      await timedSignIn(state.memberEmail, 'definitely-wrong-password-2'),
      await timedSignIn(state.memberEmail, 'definitely-wrong-password-3'),
    ];

    const ban = await patchUser(adminRequest(`/api/admin/users/${state.memberId}`, state.adminCookie, {
      method: 'PATCH',
      body: JSON.stringify({ banned: true, banReason: 'проверка' }),
    }), { params: Promise.resolve({ id: state.memberId }) });
    expect(ban.status).toBe(200);

    const blocked = await signIn(state.memberEmail, state.memberPassword);
    // AR-28: байт-в-байт тот же ответ, что Better Auth даёт на неверный пароль.
    expect(blocked.response.status).toBe(wrong.response.status);
    expect(blocked.json).toEqual(wrong.json);
    const blockedTimes = [
      await timedSignIn(state.memberEmail, state.memberPassword),
      await timedSignIn(state.memberEmail, state.memberPassword),
    ];
    expect(median(blockedTimes)).toBeGreaterThan(5);
    expect(median(blockedTimes)).toBeGreaterThan(median(wrongTimes) / 2);

    const list = await payloadOf(await listUsers(adminRequest(`/api/admin/users?q=${encodeURIComponent(state.memberEmail)}`, state.adminCookie)));
    const banned = ((list?.data?.items ?? []) as Array<{ banned: boolean }>)[0];
    expect(banned?.banned).toBe(true);

    const unban = await patchUser(adminRequest(`/api/admin/users/${state.memberId}`, state.adminCookie, {
      method: 'PATCH',
      body: JSON.stringify({ banned: false }),
    }), { params: Promise.resolve({ id: state.memberId }) });
    expect(unban.status).toBe(200);
    const afterUnban = await signIn(state.memberEmail, state.memberPassword);
    expect(afterUnban.response.status).toBe(200);
    // Бан удалил сессии: для следующих проверок нужен свежий cookie.
    state.memberCookie = afterUnban.cookie;
  });

  async function makeInviteViaApi(body: Record<string, unknown>) {
    const response = await createInviteRoute(adminRequest('/api/admin/invites', state.adminCookie, {
      method: 'POST',
      body: JSON.stringify(body),
    }));
    const payload = await payloadOf(response);
    const data = (payload?.data ?? {}) as {
      id?: string; url?: string; maxUses?: number | null; usedCount?: number; expiresAt?: string | null; email?: string | null;
    };
    return { response, id: data.id ?? '', token: (data.url ?? '').split('invite=')[1] ?? '', data };
  }

  it('создаёт одноразовый инвайт по умолчанию: второй раз не пускает, отзыв работает', async () => {
    const created = await makeInviteViaApi({ ttlHours: 1 });
    expect(created.response.status).toBe(200);
    expect(created.token).toBeTruthy();
    expect(created.data.maxUses).toBe(1);
    expect(created.data.usedCount).toBe(0);

    const invited = await authCall('/sign-up/email', {
      email: uniqueEmail('invited'), password: 'invited-password-1', name: 'invited', invite: created.token,
    });
    expect(invited.response.status).toBe(200);

    const again = await authCall('/sign-up/email', {
      email: uniqueEmail('invited'), password: 'invited-password-1', name: 'invited', invite: created.token,
    });
    expect(again.response.status).toBe(403);

    // AR-35: отзыв разрешён и после использования — многоразовый мог быть не исчерпан.
    const revoke = await revokeInviteRoute(adminRequest(`/api/admin/invites/${created.id}`, state.adminCookie, { method: 'DELETE' }),
      { params: Promise.resolve({ id: created.id }) });
    expect(revoke.status).toBe(200);

    const list = await listInvites(adminRequest('/api/admin/invites?state=revoked', state.adminCookie));
    expect(list.status).toBe(200);
    const items = ((await payloadOf(list))?.data?.items ?? []) as Array<{ id: string; usedCount: number; maxUses: number | null }>;
    const row = items.find(item => item.id === created.id);
    expect(row).toMatchObject({ usedCount: 1, maxUses: 1 });
  });

  it('многоразовый инвайт: лимит 2, два успеха и отказ третьему (AR-35)', async () => {
    const created = await makeInviteViaApi({ ttlHours: 1, maxUses: 2 });
    expect(created.response.status).toBe(200);
    expect(created.data.maxUses).toBe(2);

    const usedEmails: string[] = [];
    for (let index = 0; index < 2; index++) {
      const email = uniqueEmail(`multi-${index}`);
      usedEmails.push(email);
      const signUp = await authCall('/sign-up/email', {
        email, password: 'multi-password-12', name: `multi-${index}`, invite: created.token,
      });
      expect(signUp.response.status).toBe(200);
    }
    const third = await authCall('/sign-up/email', {
      email: uniqueEmail('multi-third'), password: 'multi-password-12', name: 'multi-third', invite: created.token,
    });
    expect(third.response.status).toBe(403);
    expect(String(third.json?.message ?? '')).toContain('Лимит');

    const list = await listInvites(adminRequest('/api/admin/invites?state=used', state.adminCookie));
    const items = ((await payloadOf(list))?.data?.items ?? []) as Array<{
      id: string; usedCount: number; maxUses: number | null; usedBy: string | null;
    }>;
    expect(items.find(item => item.id === created.id)).toMatchObject({
      usedCount: 2, maxUses: 2, usedBy: usedEmails[1],
    });

    // AR-39: каждое использование пишет audit invite.use (актор — новый аккаунт).
    const logs = await payloadOf(await listLogs(adminRequest('/api/admin/logs?limit=100&action=invite.use', state.adminCookie)));
    const uses = ((logs?.data?.items ?? []) as Array<{
      action: string; targetId: string | null; actorEmail: string; details: { email?: string } | null;
    }>).filter(item => item.action === 'invite.use' && item.targetId === created.id);
    expect(uses).toHaveLength(2);
    expect(uses.map(item => item.details?.email).sort()).toEqual([...usedEmails].sort());
    expect(uses.every(item => usedEmails.includes(item.actorEmail))).toBe(true);
  });

  it('неудачная регистрация возвращает расход и не портит «последнее использование» (AR-40)', async () => {
    const created = await makeInviteViaApi({ ttlHours: 1, maxUses: 2 });
    const email = uniqueEmail('release');
    const first = await authCall('/sign-up/email', {
      email, password: 'release-password-12', name: 'release', invite: created.token,
    });
    expect(first.response.status).toBe(200);

    // Повторная регистрация того же адреса: расход уже сделан в before-хуке,
    // after возвращает его, потому что аккаунт не создан.
    const duplicate = await authCall('/sign-up/email', {
      email, password: 'release-password-12', name: 'release', invite: created.token,
    });
    expect(duplicate.response.status).not.toBe(200);

    const list = await listInvites(adminRequest('/api/admin/invites?state=all', state.adminCookie));
    const items = ((await payloadOf(list))?.data?.items ?? []) as Array<{
      id: string; usedCount: number; usedBy: string | null;
    }>;
    expect(items.find(item => item.id === created.id)).toMatchObject({ usedCount: 1, usedBy: email });
  });

  it('две параллельные регистрации по одноразовому инвайту: один успех и один отказ (AR-35)', async () => {
    const created = await makeInviteViaApi({ ttlHours: 1, maxUses: 1 });
    const [first, second] = await Promise.all([
      authCall('/sign-up/email', {
        email: uniqueEmail('race-a'), password: 'race-password-12', name: 'race-a', invite: created.token,
      }),
      authCall('/sign-up/email', {
        email: uniqueEmail('race-b'), password: 'race-password-12', name: 'race-b', invite: created.token,
      }),
    ]);
    expect([first.response.status, second.response.status].sort()).toEqual([200, 403]);
  });

  it('инвайт с привязкой к email отклоняет чужой адрес (AR-35)', async () => {
    const boundEmail = uniqueEmail('bound');
    const created = await makeInviteViaApi({ ttlHours: 1, maxUses: 1, email: boundEmail });
    expect(created.data.email).toBe(boundEmail);

    const foreign = await authCall('/sign-up/email', {
      email: uniqueEmail('foreign'), password: 'foreign-password-1', name: 'foreign', invite: created.token,
    });
    expect(foreign.response.status).toBe(403);
    expect(String(foreign.json?.message ?? '')).toContain('другого адреса');

    const own = await authCall('/sign-up/email', {
      email: boundEmail, password: 'bound-password-12', name: 'bound', invite: created.token,
    });
    expect(own.response.status).toBe(200);
  });

  it('использование инвайта переживает удаление пользователя (AR-42)', async () => {
    const created = await makeInviteViaApi({ ttlHours: 1, maxUses: 1 });
    const email = uniqueEmail('fk');
    const signUp = await authCall('/sign-up/email', {
      email, password: 'fk-password-12', name: 'fk', invite: created.token,
    });
    expect(signUp.response.status).toBe(200);

    const users = await pgQuery(`SELECT id FROM "user" WHERE lower(email) = lower($1)`, [email]);
    const userId = (users as { rows: Array<{ id: string }> }).rows[0]?.id;
    expect(userId).toBeTruthy();

    const before = await pgQuery(`SELECT user_id FROM invite_use WHERE invite_id = $1`, [created.id]);
    expect((before as { rows: Array<{ user_id: string | null }> }).rows[0]?.user_id).toBe(userId);

    // Миграция 0007: FK user_id → user(id) ON DELETE SET NULL, строка не висит.
    await pgQuery(`DELETE FROM "user" WHERE id = $1`, [userId]);
    const after = await pgQuery(`SELECT user_id FROM invite_use WHERE invite_id = $1`, [created.id]);
    expect((after as { rows: Array<{ user_id: string | null }> }).rows[0]?.user_id).toBeNull();
  });

  it('истёкший и безлимитный инвайты (AR-35)', async () => {
    const expired = await makeInviteViaApi({ expiresAt: new Date(Date.now() + 3600_000).toISOString(), maxUses: 1 });
    await pgQuery(`UPDATE "invite" SET expires_at = now() - interval '1 hour' WHERE id = $1`, [expired.id]);
    const late = await authCall('/sign-up/email', {
      email: uniqueEmail('late'), password: 'late-password-12', name: 'late', invite: expired.token,
    });
    expect(late.response.status).toBe(403);
    expect(String(late.json?.message ?? '')).toContain('Срок');

    const unlimited = await makeInviteViaApi({ ttlHours: null, maxUses: null });
    expect(unlimited.data.maxUses).toBeNull();
    expect(unlimited.data.expiresAt).toBeNull();
    for (let index = 0; index < 2; index++) {
      const signUp = await authCall('/sign-up/email', {
        email: uniqueEmail(`unlimited-${index}`), password: 'unlimited-pw-12', name: `u${index}`, invite: unlimited.token,
      });
      expect(signUp.response.status).toBe(200);
    }
  });

  it('отзывает неиспользованный инвайт: регистрация по нему невозможна', async () => {
    const created = await createInviteRoute(adminRequest('/api/admin/invites', state.adminCookie, {
      method: 'POST',
      body: JSON.stringify({ ttlHours: 1 }),
    }));
    const createdPayload = await payloadOf(created);
    const id = String(createdPayload?.data?.id ?? '');
    const token = String(createdPayload?.data?.url ?? '').split('invite=')[1] ?? '';

    const revoke = await revokeInviteRoute(adminRequest(`/api/admin/invites/${id}`, state.adminCookie, { method: 'DELETE' }),
      { params: Promise.resolve({ id }) });
    expect(revoke.status).toBe(200);

    const attempt = await authCall('/sign-up/email', {
      email: uniqueEmail('revoked'), password: 'revoked-password-1', name: 'revoked', invite: token,
    });
    expect(attempt.response.status).toBe(403);
  });

  it('выдаёт одноразовую ссылку сброса пароля, и она работает', async () => {
    const response = await resetPasswordLink(
      adminRequest(`/api/admin/users/${state.memberId}/reset-password`, state.adminCookie, { method: 'POST' }),
      { params: Promise.resolve({ id: state.memberId }) },
    );
    expect(response.status).toBe(200);
    const payload = await payloadOf(response);
    const url = String(payload?.data?.url ?? '');
    const token = url.match(/\/reset-password\/([^?]+)/)?.[1] ?? '';
    expect(token).toBeTruthy();

    const { getAuth } = await import('../lib/auth');
    const reset = await getAuth().handler(new Request(`${BASE}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-real-ip': nextIp() },
      body: JSON.stringify({ newPassword: 'member-new-password-2', token }),
    }));
    expect(reset.status).toBe(200);
    expect((await signIn(state.memberEmail, 'member-new-password-2')).response.status).toBe(200);

    const secondUse = await getAuth().handler(new Request(`${BASE}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-real-ip': nextIp() },
      body: JSON.stringify({ newPassword: 'member-new-password-3', token }),
    }));
    expect(secondUse.status).toBe(400);
  });

  it('защищает изменяющие запросы админки от чужого Origin и не-JSON (AR-29)', async () => {
    const plain = await createInviteRoute(new Request(`${BASE}/api/admin/invites`, {
      method: 'POST',
      headers: { cookie: state.adminCookie, 'content-type': 'text/plain' },
      body: 'x',
    }));
    expect(plain.status).toBe(415);

    const foreign = await createInviteRoute(new Request(`${BASE}/api/admin/invites`, {
      method: 'POST',
      headers: { cookie: state.adminCookie, 'content-type': 'application/json', origin: 'https://evil.example' },
      body: '{}',
    }));
    expect(foreign.status).toBe(403);
  });

  it('пишет действия в журнал и не даёт удалить себя', async () => {
    const logs = await listLogs(adminRequest('/api/admin/logs?limit=100&period=all', state.adminCookie));
    expect(logs.status).toBe(200);
    const items = ((await payloadOf(logs))?.data?.items ?? []) as Array<{ action: string; actorEmail: string }>;
    const actions = items.map(item => item.action);
    for (const action of ['user.role_change', 'user.ban', 'invite.create', 'user.password_reset']) {
      expect(items.some(item => item.action === action && item.actorEmail === state.adminEmail), action).toBe(true);
    }

    const self = await deleteUser(adminRequest(`/api/admin/users/${state.adminId}`, state.adminCookie, { method: 'DELETE' }),
      { params: Promise.resolve({ id: state.adminId }) });
    expect(self.status).toBe(409);
  });

  it('закрывает настройки ядра и хвост лога от гостя и обычного пользователя', async () => {
    expect((await getCoreConfig(adminRequest('/api/admin/config'))).status).toBe(401);
    expect((await getCoreConfig(adminRequest('/api/admin/config', state.memberCookie))).status).toBe(403);
    expect((await getLogTail(adminRequest('/api/admin/logs/tail?lines=10'))).status).toBe(401);
    expect((await getLogTail(adminRequest('/api/admin/logs/tail?lines=10', state.memberCookie))).status).toBe(403);

    const memberWrite = await putCoreConfig(adminRequest('/api/admin/config', state.memberCookie, {
      method: 'PUT',
      body: JSON.stringify({ updates: { 'llm.talk_model.model': 'member-model' } }),
    }));
    expect(memberWrite.status).toBe(403);

    const invalid = await putCoreConfig(adminRequest('/api/admin/config', state.adminCookie, {
      method: 'PUT',
      body: JSON.stringify({ updates: {} }),
    }));
    expect(invalid.status).toBe(400);
  });

  it('режим регистрации: админ меняет, хук регистрации слушается', async () => {
    expect((await getSettings(adminRequest('/api/admin/settings'))).status).toBe(401);
    expect((await getSettings(adminRequest('/api/admin/settings', state.memberCookie))).status).toBe(403);

    const initial = await getSettings(adminRequest('/api/admin/settings', state.adminCookie));
    expect(initial.status).toBe(200);
    expect((await payloadOf(initial))?.data?.registration_mode).toBe('invite');

    const setMode = async (mode: string) => putSettings(adminRequest('/api/admin/settings', state.adminCookie, {
      method: 'PUT',
      body: JSON.stringify({ registration_mode: mode }),
    }));

    try {
      expect((await setMode('everyone')).status).toBe(400);

      const open = await setMode('open');
      expect(open.status).toBe(200);
      expect((await payloadOf(open))?.data?.registration_mode).toBe('open');
      const openSignup = await authCall('/sign-up/email', {
        email: uniqueEmail('open-mode'), password: 'open-mode-password-1', name: 'open',
      });
      expect(openSignup.response.status).toBe(200);

      expect((await setMode('closed')).status).toBe(200);
      const closedSignup = await authCall('/sign-up/email', {
        email: uniqueEmail('closed-mode'), password: 'closed-mode-password-1', name: 'closed', invite: makeInvite(),
      });
      expect(closedSignup.response.status).toBe(403);
      expect(String(closedSignup.json?.message ?? '')).toContain('закрыта');

      expect((await setMode('invite')).status).toBe(200);
      const withoutInvite = await authCall('/sign-up/email', {
        email: uniqueEmail('invite-mode-no'), password: 'invite-mode-password-1', name: 'no',
      });
      expect(withoutInvite.response.status).toBe(403);
      const withInvite = await authCall('/sign-up/email', {
        email: uniqueEmail('invite-mode-yes'), password: 'invite-mode-password-1', name: 'yes', invite: makeInvite(),
      });
      expect(withInvite.response.status).toBe(200);

      const logs = await listLogs(adminRequest('/api/admin/logs?limit=100&period=all', state.adminCookie));
      const items = ((await payloadOf(logs))?.data?.items ?? []) as Array<{ action: string; actorEmail: string }>;
      expect(items.some(item => item.action === 'settings.write' && item.actorEmail === state.adminEmail)).toBe(true);
    } finally {
      await setMode('invite');
    }
  });

  it('закрывает каталог Discord от гостя и обычного пользователя', async () => {
    const guildParams = { params: Promise.resolve({ guildId: 'g1' }) };
    const statsParams = { params: Promise.resolve({ personId: 'p1' }) };
    const calls: Array<[string, Promise<Response>]> = [
      ['guilds', discordGuilds(adminRequest('/api/admin/discord/guilds'))],
      ['guild', discordGuild(adminRequest('/api/admin/discord/guilds/g1'), guildParams)],
      ['members', discordMembers(adminRequest('/api/admin/discord/members'))],
      ['stats', discordUserStats(adminRequest('/api/admin/discord/users/p1/stats'), statsParams)],
      ['messages', discordMessages(adminRequest('/api/admin/discord/messages'))],
    ];
    for (const [name, pending] of calls) {
      expect((await pending).status, name).toBe(401);
    }
    const memberCalls: Array<[string, Promise<Response>]> = [
      ['guilds', discordGuilds(adminRequest('/api/admin/discord/guilds', state.memberCookie))],
      ['guild', discordGuild(adminRequest('/api/admin/discord/guilds/g1', state.memberCookie), guildParams)],
      ['members', discordMembers(adminRequest('/api/admin/discord/members', state.memberCookie))],
      ['stats', discordUserStats(adminRequest('/api/admin/discord/users/p1/stats', state.memberCookie), statsParams)],
      ['messages', discordMessages(adminRequest('/api/admin/discord/messages', state.memberCookie))],
    ];
    for (const [name, pending] of memberCalls) {
      expect((await pending).status, name).toBe(403);
    }
  });

  it('два параллельных понижения не оставляют сайт без админа (AR-30)', async () => {
    // Второй админ — бывший участник; пароль изменён тестом сброса.
    grantAdmin(state.memberEmail);
    try {
      const memberLogin = await signIn(state.memberEmail, 'member-new-password-2');
      expect(memberLogin.response.status).toBe(200);
      const memberCookie = memberLogin.cookie;

      const [demoteMember, demoteAdmin] = await Promise.all([
        patchUser(adminRequest(`/api/admin/users/${state.memberId}`, state.adminCookie, {
          method: 'PATCH',
          body: JSON.stringify({ role: 'user' }),
        }), { params: Promise.resolve({ id: state.memberId }) }),
        patchUser(adminRequest(`/api/admin/users/${state.adminId}`, memberCookie, {
          method: 'PATCH',
          body: JSON.stringify({ role: 'user' }),
        }), { params: Promise.resolve({ id: state.adminId }) }),
      ]);
      expect([demoteMember.status, demoteAdmin.status].sort()).toEqual([200, 409]);
    } finally {
      // Восстанавливаем исходные роли даже при падении проверки.
      grantAdmin(state.adminEmail);
      execFileSync(process.execPath, [join(repoRoot(), 'web/scripts/grant-admin.mjs'), state.memberEmail, '--revoke'],
        { env: process.env, encoding: 'utf-8' });
    }
  });

  it('роль цели перечитывается под блокировкой (AR-34)', async () => {
    const password = 'ar34-password-77';
    const adminEmail = uniqueEmail('ar34-admin');
    const userEmail = uniqueEmail('ar34-user');

    expect((await signUp(adminEmail, password)).response.status).toBe(200);
    expect((await signUp(userEmail, password)).response.status).toBe(200);
    grantAdmin(adminEmail);

    const adminLogin = await signIn(adminEmail, password);
    expect(adminLogin.response.status).toBe(200);
    const actorId = String((adminLogin.json as { user?: { id?: string } } | null)?.user?.id ?? '');
    const userLogin = await signIn(userEmail, password);
    expect(userLogin.response.status).toBe(200);
    const targetId = String((userLogin.json as { user?: { id?: string } } | null)?.user?.id ?? '');
    expect(actorId).toBeTruthy();
    expect(targetId).toBeTruthy();

    // Прежние админы вернутся после теста: сценарию нужен ровно один админ.
    const adminsBefore = ((await pgQuery(`SELECT id FROM "user" WHERE role = 'admin'`)) as {
      rows: Array<{ id: string }>;
    }).rows.map(row => row.id);

    const { Client } = await import('pg');
    const holder = new Client({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 5000 });
    let pending: Promise<Response> | undefined;
    try {
      await holder.connect();
      try {
        // Держим advisory-lock, как это делает параллельное изменение ролей.
        await holder.query('BEGIN');
        await holder.query('SELECT pg_advisory_xact_lock(734002)');

        // Удаление читает цель как обычного пользователя и встаёт на блокировку.
        pending = deleteUser(adminRequest(`/api/admin/users/${targetId}`, adminLogin.cookie, { method: 'DELETE' }),
          { params: Promise.resolve({ id: targetId }) });
        await new Promise((resolve) => setTimeout(resolve, 400));

        // Пока запрос ждёт: цель становится админом, а прежний админ — обычным
        // пользователем. Единственный админ теперь — цель удаления.
        await holder.query(`UPDATE "user" SET role = 'admin' WHERE id = $1`, [targetId]);
        await holder.query(`UPDATE "user" SET role = 'user' WHERE role = 'admin' AND id <> $1`, [targetId]);
        const [counted] = (await holder.query(`SELECT count(*)::int AS admins FROM "user" WHERE role = 'admin'`)).rows as Array<{ admins: number }>;
        expect(counted.admins).toBe(1);
        await holder.query('COMMIT');
      } finally {
        await holder.query('ROLLBACK').catch(() => {});
        await holder.end().catch(() => {});
      }

      const response = await pending!;
      // Старое чтение роли дало бы 200 и удалило последнего админа.
      expect(response.status).toBe(409);
      expect(((await payloadOf(response)) as { error?: string } | null)?.error).toBe('last-admin');

      const still = await pgQuery(`SELECT role FROM "user" WHERE id = $1`, [targetId]);
      expect((still as { rows: Array<{ role: string }> }).rows[0]?.role).toBe('admin');
    } finally {
      // Убираем тестовые аккаунты и возвращаем прежние роли админов даже при падении.
      await pgQuery(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [[actorId, targetId]]);
      await pgQuery(`UPDATE "user" SET role = 'admin' WHERE id = ANY($1::text[])`, [adminsBefore]);
    }
  });
});
