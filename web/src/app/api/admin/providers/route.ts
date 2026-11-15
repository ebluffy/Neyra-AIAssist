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
  if (result.state === 'unconfigured') {
    // Без admin-ключа ядро недоступно: подменять каталог нельзя (AR-36).
    return jsonError(503, 'core_unconfigured', 'Ядро не подключено: не задан admin-ключ сайта.');
  }
  if (result.state === 'unsupported') {
    // Мягкая деградация: ручки /v1/providers нет в текущем ядре (#75 ещё не смержен).
    // 200 + supported:false вместо 502/404, чтобы браузер не писал ошибку в консоль.
    return jsonOk({
      supported: false,
      message: result.message ?? 'Ядро не поддерживает управление провайдерами.',
      providers: [],
      presets: [],
      lanes: [],
    });
  }
  if (result.state !== 'ok' || !result.data) {
    // AR-68: подставной каталог запрещён. Лежащее ядро — это ошибка, а не пустой список.
    return jsonError(502, 'core_unavailable', 'Ядро недоступно: список провайдеров не получен.');
  }
  return jsonOk(result.data);
}
