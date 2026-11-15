import { requireAdmin } from '../../../../../lib/admin-guard';
import { jsonOk } from '../../../../../lib/admin-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Персона и системные промпты живут в конфиге ядра; публичного API чтения у них нет.
// Панель не читает файлы ядра напрямую: это обошло бы его права и версионирование.
export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  return jsonOk({
    state: 'no_api',
    items: [],
    message: 'Ядро пока не отдаёт персону и системные промпты через API. Раздел включим вместе с API чтения в ядре.',
  });
}
