import { requireAdmin } from '../../../../../../lib/admin-guard';
import { deleteUser, getUser, setUserBanned, setUserRole } from '../../../../../../lib/admin-users';
import { recordAudit } from '../../../../../../lib/admin-audit';
import { describeActionError, jsonError, jsonOk, readJson } from '../../../../../../lib/admin-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// PATCH: смена роли и блокировка. Каждое изменение пишется в аудит.
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  const body = await readJson(request);
  if (!body) return jsonError(400, 'bad_request', 'Ожидается JSON-объект.');
  const target = await getUser(id).catch(() => null);
  if (!target) return jsonError(404, 'not-found', 'Пользователь не найден.');

  if ('role' in body) {
    const role = body.role;
    if (role !== 'admin' && role !== 'user') {
      return jsonError(400, 'bad_request', 'Роль должна быть admin или user.');
    }
    const result = await setUserRole(auth.user.id, id, role);
    if (!result.ok) {
      const text = describeActionError(result.error);
      return jsonError(text.status, text.error, text.message);
    }
    await recordAudit(auth.user, 'user.role_change', { type: 'user', id }, { from: target.role, to: role });
    return jsonOk({ id, role });
  }

  if ('banned' in body) {
    if (typeof body.banned !== 'boolean') {
      return jsonError(400, 'bad_request', 'Поле banned должно быть true или false.');
    }
    const reasonRaw = typeof body.banReason === 'string' ? body.banReason.trim().slice(0, 200) : '';
    if (body.banned && id === auth.user.id) {
      return jsonError(409, 'self', 'Нельзя заблокировать свой аккаунт.');
    }
    const result = await setUserBanned(id, body.banned, reasonRaw || null);
    if (!result.ok) {
      const text = describeActionError(result.error);
      return jsonError(text.status, text.error, text.message);
    }
    await recordAudit(auth.user, body.banned ? 'user.ban' : 'user.unban', { type: 'user', id }, {
      reason: reasonRaw || null,
    });
    return jsonOk({ id, banned: body.banned });
  }

  return jsonError(400, 'bad_request', 'Нечего менять: укажите role или banned.');
}

// DELETE: удаление аккаунта. Сессии и аккаунты удаляются каскадом.
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  const result = await deleteUser(auth.user.id, id);
  if (!result.ok) {
    const text = describeActionError(result.error);
    return jsonError(text.status, text.error, text.message);
  }
  await recordAudit(auth.user, 'user.delete', { type: 'user', id }, { email: result.value.email });
  return jsonOk({ id, deleted: true });
}
