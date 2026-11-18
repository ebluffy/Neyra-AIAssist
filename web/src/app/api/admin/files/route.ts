import { requireAdmin } from '../../../../../lib/admin-guard';
import { coreGet } from '../../../../../lib/core-admin';
import { jsonOk } from '../../../../../lib/admin-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface AttachmentItem {
  id?: string;
  name?: string;
  mime?: string;
  size?: number;
  kind?: string;
}

// Вложения: у ядра есть загрузка и выдача по id, но нет списка всех файлов.
// Показываем честное «списка нет», а не пустую таблицу, будто файлов не существует.
export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const probe = await coreGet<AttachmentItem>('/v1/attachments', { timeoutMs: 2500 });
  return jsonOk({
    state: 'no_list_api',
    items: [],
    message: 'У ядра нет API списка вложений: файлы адресуются по id и каналу. Список включим, когда появится API перечисления.',
    coreReachable: probe.state === 'ok' || probe.state === 'error',
  });
}
