import { headers } from 'next/headers';
import { getAuth } from './auth';
import { toAdminUser, type AdminUser } from './admin-guard';

// Для серверных страниц: нет сессии или роль не admin — страница отдаёт 404.
// Вынесено из admin-guard, чтобы API-маршруты и тесты не зависели от next/headers.
export async function getAdminUser(): Promise<AdminUser | null> {
  try {
    const session = await getAuth().api.getSession({ headers: await headers() });
    return toAdminUser(session?.user as { id: string; email: string; name?: string; role?: unknown } | undefined);
  } catch {
    return null;
  }
}
