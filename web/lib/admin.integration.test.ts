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

const RUN = Boolean(process.env.AUTH_INTEGRATION_DATABASE_URL);
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
  const client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
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
    expect((await signIn(state.memberEmail, state.memberPassword)).response.status).toBe(200);
  });

  it('создаёт и отзывает инвайт, повторно не пускает', async () => {
    const created = await createInviteRoute(adminRequest('/api/admin/invites', state.adminCookie, {
      method: 'POST',
      body: JSON.stringify({ ttlHours: 1 }),
    }));
    expect(created.status).toBe(200);
    const createdPayload = await payloadOf(created);
    const url = String(createdPayload?.data?.url ?? '');
    const id = String(createdPayload?.data?.id ?? '');
    const token = url.split('invite=')[1] ?? '';
    expect(token).toBeTruthy();

    const invited = await authCall('/sign-up/email', {
      email: uniqueEmail('invited'), password: 'invited-password-1', name: 'invited', invite: token,
    });
    expect(invited.response.status).toBe(200);

    const again = await authCall('/sign-up/email', {
      email: uniqueEmail('invited'), password: 'invited-password-1', name: 'invited', invite: token,
    });
    expect(again.response.status).toBe(403);

    const revoke = await revokeInviteRoute(adminRequest(`/api/admin/invites/${id}`, state.adminCookie, { method: 'DELETE' }),
      { params: Promise.resolve({ id }) });
    expect(revoke.status).toBe(409);

    const list = await listInvites(adminRequest('/api/admin/invites?state=used', state.adminCookie));
    expect(list.status).toBe(200);
    expect(((await payloadOf(list))?.data?.items as unknown[]).length).toBeGreaterThan(0);
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

  it('два параллельных понижения не оставляют сайт без админа (AR-30)', async () => {
    // Второй админ — бывший участник; пароль изменён тестом сброса.
    grantAdmin(state.memberEmail);
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

    // Восстанавливаем исходные роли.
    grantAdmin(state.adminEmail);
    execFileSync(process.execPath, [join(repoRoot(), 'web/scripts/grant-admin.mjs'), state.memberEmail, '--revoke'],
      { env: process.env, encoding: 'utf-8' });
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
    const holder = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
    await holder.connect();
    let pending: Promise<Response> | undefined;
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

    // Убираем тестовые аккаунты и возвращаем прежние роли админов.
    await pgQuery(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [[actorId, targetId]]);
    await pgQuery(`UPDATE "user" SET role = 'admin' WHERE id = ANY($1::text[])`, [adminsBefore]);
  });
});
