import { requireAdmin } from '../../../../../lib/admin-guard';
import { countUsers, listUsers } from '../../../../../lib/admin-users';
import { parseUserListQuery } from '../../../../../lib/admin-rules';
import { jsonError, jsonOk } from '../../../../../lib/admin-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Список пользователей с поиском и пагинацией. Роль проверяется на сервере.
export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  try {
    const query = parseUserListQuery(new URL(request.url).searchParams);
    const [page, counts] = await Promise.all([listUsers(query), countUsers()]);
    return jsonOk({ ...page, counts });
  } catch {
    return jsonError(503, 'db_unavailable', 'База сайта недоступна.');
  }
}
