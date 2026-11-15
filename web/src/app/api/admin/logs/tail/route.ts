import { requireAdmin } from '../../../../../../lib/admin-guard';
import { readAdminLogTail } from '../../../../../../lib/admin-config';
import { jsonError, jsonOk } from '../../../../../../lib/admin-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Хвост лога ядра: маскирование делает ядро, сайт только передаёт число строк.
export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const lines = new URL(request.url).searchParams.get('lines');
  const result = await readAdminLogTail(lines);
  if (result.state === 'unsupported') {
    return jsonOk({ supported: false, message: result.message ?? 'Ядро не поддерживает просмотр логов.' });
  }
  if (result.state !== 'ok') {
    return jsonError(
      result.state === 'unconfigured' ? 503 : 502,
      result.state === 'unconfigured' ? 'core_unconfigured' : 'core_unavailable',
      result.message ?? 'Ядро не отдало лог.',
    );
  }
  return jsonOk(result.data ?? {});
}
