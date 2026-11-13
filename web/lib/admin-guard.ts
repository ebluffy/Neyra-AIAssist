import { getAuth } from './auth';

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
  | { ok: false; status: 401 | 403 | 503; response: Response };

function json(status: number, error: string, message: string): Response {
  return Response.json({ error, message }, { status });
}

// Проверка роли на сервере для каждого API-запроса: скрытая кнопка защитой не считается.
// Отдельно от страничной проверки, чтобы этот модуль не тянул next/headers и проверялся тестами.
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
  return { ok: true, user };
}
