import { requireAdmin } from '../../../../../lib/admin-guard';
import { coreGet, type CoreModelRoles } from '../../../../../lib/core-admin';
import { jsonOk } from '../../../../../lib/admin-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Лейны talk/brain/memory/vision: провайдер и модель берутся из ядра как есть.
// Остальные параметры (температура, лимиты, таймауты) ядро пока не отдаёт через API —
// показываем это честно, а не подставляем значения из конфига на сайте.
export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const result = await coreGet<CoreModelRoles>('/v1/llm/models', { timeoutMs: 4000 });
  return jsonOk({
    state: result.state,
    message: result.message ?? null,
    roles: result.state === 'ok' ? (result.data?.roles ?? {}) : null,
    editable: false,
    note: 'Запись параметров включим, когда ядро отдаст API настроек моделей. Сейчас — только чтение провайдера и модели.',
  });
}
