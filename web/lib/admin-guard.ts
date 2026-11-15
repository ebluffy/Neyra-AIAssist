import { getAuth } from './auth';
import { readAuthEnv } from './env';

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: 'admin';
}

export function isAdminRole(role: unknown): boolean {
  return role === 'admin';
}

export function toAdminUser(value: { id?: string; email?: string; name?: string; role?: unknown } | null | undefined): AdminUser | null {
  if (!value?.id || !value.email || !isAdminRole(value.role)) return null;
  return { id: value.id, email: value.email, name: value.name ?? value.email, role: 'admin' };
}

export type AdminAuthResult =
  | { ok: true; user: AdminUser }
  | { ok: false; status: 400 | 401 | 403 | 415 | 503; response: Response };

function json(status: number, error: string, message: string): Response {
  return Response.json({ error, message }, { status });
}

// Проверка роли на сервере для каждого API-запроса: скрытая кнопка защитой не считается.
// Отдельно от страничной проверки, чтобы этот модуль не тянул next/headers и проверялся тестами.
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// AR-29: cookie SameSite=Lax защищает не всё; для изменяющих запросов админки
// требуем JSON и, если браузер прислал Origin, совпадение с origin сайта.
function mutationGate(request: Request): Response | null {
  if (!MUTATING_METHODS.has(request.method.toUpperCase())) return null;
  const contentType = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    return json(415, 'unsupported_media_type', 'Ожидается Content-Type: application/json.');
  }
  const origin = (request.headers.get('origin') || '').trim();
  if (!origin) return null;
  let baseURL: string;
  try {
    baseURL = readAuthEnv().baseURL;
  } catch {
    return json(503, 'auth_unavailable', 'Не настроен адрес сайта для проверки Origin.');
  }
  const normalize = (value: string) => value.replace(/\/+$/, '').toLowerCase();
  if (normalize(origin) !== normalize(baseURL)) {
    return json(403, 'invalid_origin', 'Запрос с чужого Origin отклонён.');
  }
  return null;
}

export async function requireAdmin(request: Request): Promise<AdminAuthResult> {
  let session;
  try {
    session = await getAuth().api.getSession({ headers: request.headers });
  } catch {
    return { ok: false, status: 503, response: json(503, 'auth_unavailable', 'Сервис входа временно недоступен.') };
  }
  if (!session?.user) return { ok: false, status: 401, response: json(401, 'unauthorized', 'Требуется вход.') };
  const user = toAdminUser(session.user as { id: string; email: string; name?: string; role?: unknown });
  if (!user) return { ok: false, status: 403, response: json(403, 'forbidden', 'Доступ только для администратора.') };
  const blocked = mutationGate(request);
  if (blocked) return { ok: false, status: blocked.status as 400 | 401 | 403 | 415 | 503, response: blocked };
  return { ok: true, user };
}
