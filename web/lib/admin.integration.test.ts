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

function adminRequest(path: string, cookie?: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (cookie) headers.set('cookie', cookie);
  headers.set('content-type', 'application/json');
  return new Request(`${BASE}${path}`, { ...init, headers });
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
    const ban = await patchUser(adminRequest(`/api/admin/users/${state.memberId}`, state.adminCookie, {
      method: 'PATCH',
      body: JSON.stringify({ banned: true, banReason: 'проверка' }),
    }), { params: Promise.resolve({ id: state.memberId }) });
    expect(ban.status).toBe(200);

    const blocked = await signIn(state.memberEmail, state.memberPassword);
    // AR-28: не раскрываем бан и существование адреса — тот же 401, что и при неверном пароле.
    expect(blocked.response.status).toBe(401);
    expect(String(blocked.json?.message ?? '')).not.toContain('заблокирован');

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
});
