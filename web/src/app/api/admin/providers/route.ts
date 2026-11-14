import { requireAdmin } from '../../../../../lib/admin-guard';
import { readProviders } from '../../../../../lib/admin-providers';
import { jsonError, jsonOk } from '../../../../../lib/admin-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Список провайдеров и каталог пресетов. Ключи приходят только флагом.
export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;

  const result = await readProviders();
  if (result.state !== 'ok' || !result.data) {
    return jsonError(
      result.state === 'unconfigured' ? 503 : 502,
      result.state === 'unconfigured' ? 'core_unconfigured' : 'core_unavailable',
      result.message ?? 'Ядро не отдало список провайдеров.',
    );
  }
  return jsonOk(result.data);
}
