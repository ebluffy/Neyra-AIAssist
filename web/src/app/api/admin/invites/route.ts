import { requireAdmin } from '../../../../../lib/admin-guard';
import { countInvites, createInvite, listInvites } from '../../../../../lib/admin-invites';
import { normalizeInviteTtl, parseInviteListQuery } from '../../../../../lib/admin-rules';
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
  const ttl = normalizeInviteTtl(body.ttlHours ?? 24);
  if (ttl === null) {
    return jsonError(400, 'bad_request', 'Срок действия — от 1 до 720 часов.');
  }
  let baseUrl: string;
  try {
    baseUrl = readAuthEnv().baseURL;
  } catch {
    return jsonError(503, 'unavailable', 'Не задан BETTER_AUTH_URL: ссылку приглашения не собрать.');
  }
  try {
    const created = await createInvite(auth.user.email, ttl, baseUrl);
    await recordAudit(auth.user, 'invite.create', { type: 'invite', id: created.id }, { ttlHours: ttl });
    return jsonOk(created);
  } catch {
    return jsonError(503, 'db_unavailable', 'Не удалось создать инвайт: база недоступна.');
  }
}
