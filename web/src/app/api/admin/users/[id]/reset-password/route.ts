import { requireAdmin } from '../../../../../../../lib/admin-guard';
import { createResetLink } from '../../../../../../../lib/admin-password';
import { getUser } from '../../../../../../../lib/admin-users';
import { recordAudit } from '../../../../../../../lib/admin-audit';
import { jsonError, jsonOk } from '../../../../../../../lib/admin-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Одноразовая ссылка сброса пароля: письма не отправляются, админ передаёт её сам.
// Сама ссылка не пишется ни в аудит, ни в логи.
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  const target = await getUser(id).catch(() => null);
  if (!target) return jsonError(404, 'not-found', 'Пользователь не найден.');
  const result = await createResetLink(target.email);
  if (!result.ok) {
    if (result.reason === 'not-found') {
      return jsonError(404, 'not-found', 'Не удалось создать ссылку: пользователь не найден.');
    }
    return jsonError(503, 'unavailable', 'Сброс пароля недоступен: проверьте настройки входа сайта.');
  }
  await recordAudit(auth.user, 'user.password_reset', { type: 'user', id }, { email: target.email });
  return jsonOk({ id, url: result.url });
}
