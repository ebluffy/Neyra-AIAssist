import { requireAdmin } from '../../../../../../lib/admin-guard';
import { corePost } from '../../../../../../lib/core-admin';
import { recordAudit } from '../../../../../../lib/admin-audit';
import { jsonError, jsonOk, readJson } from '../../../../../../lib/admin-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Перезапуск ядра — через API ядра (мягкая остановка, systemd/docker поднимает снова).
// Перезапуск самого сайта отсюда невозможен: процессу Next нужен systemd-доступ,
// которого у пользователя сайта нет. Возвращаем понятный отказ, а не имитацию.
export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const body = await readJson(request);
  const target = body?.target;
  if (target === 'site') {
    return jsonError(501, 'not_available', 'Перезапуск сайта с этой панели недоступен: нужен доступ к systemd. Используйте deploy-скрипт на сервере.');
  }
  if (target !== 'core') return jsonError(400, 'bad_request', 'Укажите target: core.');
  const result = await corePost<{ action?: string; note?: string }>('/v1/system/restart', {}, { timeoutMs: 5000 });
  if (result.state !== 'ok') {
    return jsonError(503, 'core_unavailable', result.message ?? 'Ядро не приняло команду перезапуска.');
  }
  await recordAudit(auth.user, 'system.restart', { type: 'core', id: 'core' }, {});
  return jsonOk({ target: 'core', note: result.data?.note ?? null });
}
