import { requireAdmin } from '../../../../../../lib/admin-guard';
import { revokeInvite } from '../../../../../../lib/admin-invites';
import { recordAudit } from '../../../../../../lib/admin-audit';
import { jsonError, jsonOk } from '../../../../../../lib/admin-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Отзыв инвайта: строка остаётся в списке, но ссылка больше не работает.
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  let result: Awaited<ReturnType<typeof revokeInvite>>;
  try {
    result = await revokeInvite(id);
  } catch {
    return jsonError(503, 'db_unavailable', 'База сайта недоступна.');
  }
  if (result === 'not-found') return jsonError(404, 'not-found', 'Инвайт не найден.');
  if (result === 'used') return jsonError(409, 'used', 'Инвайт уже использован: отзывать нечего.');
  if (result === 'revoked') return jsonError(409, 'revoked', 'Инвайт уже отозван.');
  await recordAudit(auth.user, 'invite.revoke', { type: 'invite', id });
  return jsonOk({ id, revoked: true });
}
