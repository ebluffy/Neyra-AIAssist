import { requireAdmin } from '../../../../../../lib/admin-guard';
import { corePost } from '../../../../../../lib/core-admin';
import { recordAudit } from '../../../../../../lib/admin-audit';
import { jsonError, jsonOk } from '../../../../../../lib/admin-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Прогрев сессий Responses: ядро принимает команду и возвращает статус менеджера.
export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const result = await corePost<{ accepted?: boolean }>('/v1/llm/sessions/warmup', {}, { timeoutMs: 8000 });
  if (result.state !== 'ok') {
    const status = result.status === 409 ? 409 : result.state === 'unconfigured' ? 503 : 502;
    return jsonError(status, 'core_unavailable', result.message ?? 'Ядро не приняло прогрев сессий.');
  }
  await recordAudit(auth.user, 'system.warmup', { type: 'core', id: 'sessions' }, {
    accepted: Boolean(result.data?.accepted),
  });
  return jsonOk(result.data ?? {});
}
