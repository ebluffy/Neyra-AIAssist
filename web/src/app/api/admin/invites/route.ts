import { requireAdmin } from '../../../../../lib/admin-guard';
import { countInvites, createInvite, listInvites } from '../../../../../lib/admin-invites';
import {
  normalizeInviteEmail,
  normalizeInviteExpiry,
  normalizeInviteMaxUses,
  parseInviteListQuery,
} from '../../../../../lib/admin-rules';
import { readAuthEnv } from '../../../../../lib/env';
import { recordAudit } from '../../../../../lib/admin-audit';
import { jsonError, jsonOk, readJson } from '../../../../../lib/admin-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  try {
    const query = parseInviteListQuery(new URL(request.url).searchParams);
    const [page, counts] = await Promise.all([listInvites(query), countInvites()]);
    return jsonOk({ ...page, counts });
  } catch {
    return jsonError(503, 'db_unavailable', 'База сайта недоступна.');
  }
}

// Создание инвайта: ссылка возвращается один раз, в базе только хэш токена.
export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const body = await readJson(request);
  if (!body) return jsonError(400, 'bad_request', 'Ожидается JSON-объект.');
  // AR-35: лимит, срок и привязка к email. Принимаем camelCase и snake_case.
  // Явный null («без лимита») нельзя путать с отсутствием поля (по умолчанию 1).
  const maxUses = normalizeInviteMaxUses('maxUses' in body ? body.maxUses : body.max_uses);
  if (maxUses === 'invalid') {
    return jsonError(400, 'bad_request', 'Лимит использований — целое число от 1 до 10000 или null (без лимита).');
  }
  const expiresAt = normalizeInviteExpiry({
    expiresAt: 'expiresAt' in body ? body.expiresAt : body.expires_at,
    ttlHours: body.ttlHours,
  });
  if (expiresAt === 'invalid') {
    return jsonError(400, 'bad_request', 'Срок действия — будущая дата, от 1 до 720 часов или null (без срока).');
  }
  const email = normalizeInviteEmail(body.email);
  if (email === 'invalid') {
    return jsonError(400, 'bad_request', 'Email для инвайта должен быть корректным адресом или null.');
  }
  let baseUrl: string;
  try {
    baseUrl = readAuthEnv().baseURL;
  } catch {
    return jsonError(503, 'unavailable', 'Не задан BETTER_AUTH_URL: ссылку приглашения не собрать.');
  }
  try {
    const created = await createInvite(auth.user.email, { maxUses, expiresAt, email }, baseUrl);
    await recordAudit(auth.user, 'invite.create', { type: 'invite', id: created.id }, {
      maxUses,
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
      email,
    });
    return jsonOk(created);
  } catch {
    return jsonError(503, 'db_unavailable', 'Не удалось создать инвайт: база недоступна.');
  }
}
