import { getAuth } from '../../../../lib/auth';
import { setUserName } from '../../../../lib/admin-users';
import { jsonError, jsonOk, readJson } from '../../../../lib/admin-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_NAME_LENGTH = 100;

// AR-74: своё имя меняет сам пользователь. Админская ручка
// /api/admin/users/{id} требует роль admin, поэтому для обычного пользователя
// нужна отдельная дверь: только name, только для своей сессии.
export async function PATCH(request: Request) {
  let session;
  try {
    session = await getAuth().api.getSession({ headers: request.headers });
  } catch {
    return jsonError(503, 'auth_unavailable', 'Сервис входа временно недоступен.');
  }
  if (!session?.user) {
    return jsonError(401, 'unauthorized', 'Требуется авторизация.');
  }

  const body = await readJson(request);
  if (!body) {
    return jsonError(400, 'bad_request', 'Ожидается JSON-объект.');
  }
  const extra = Object.keys(body).filter((key) => key !== 'name');
  if (extra.length > 0) {
    return jsonError(400, 'bad_request', 'Менять можно только name.');
  }
  if (typeof body.name !== 'string') {
    return jsonError(400, 'bad_request', 'Поле name должно быть строкой.');
  }
  const name = body.name.trim();
  if (!name) {
    return jsonError(400, 'bad_request', 'Имя не может быть пустым.');
  }
  if (name.length > MAX_NAME_LENGTH) {
    return jsonError(400, 'bad_request', `Имя длиннее ${MAX_NAME_LENGTH} символов.`);
  }

  const result = await setUserName(session.user.id, name);
  if (!result.ok) {
    return jsonError(500, 'db_error', 'Не удалось обновить имя. Попробуйте ещё раз.');
  }
  return jsonOk({ name });
}
