import { requireAdmin } from '../../../../../../../lib/admin-guard';
import {
  deleteProviderSecret,
  isValidProviderName,
  writeProviderSecret,
} from '../../../../../../../lib/admin-providers';
import { recordAudit } from '../../../../../../../lib/admin-audit';
import { jsonError, jsonOk, readJson } from '../../../../../../../lib/admin-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Ключ провайдера: приходит один раз на запись и уходит в шифрованный vault ядра.
// В ответе и в аудите только длина/факт записи, никогда само значение.
export async function PUT(request: Request, context: { params: Promise<{ name: string }> }) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const { name } = await context.params;
  if (!isValidProviderName(name)) {
    return jsonError(400, 'invalid_provider', 'Некорректное имя провайдера.');
  }
  const body = await readJson(request);
  const apiKey = typeof (body as { api_key?: unknown })?.api_key === 'string'
    ? ((body as { api_key: string }).api_key || '').trim()
    : '';
  if (apiKey.length < 8) {
    return jsonError(400, 'invalid_key', 'Ключ слишком короткий: нужно не меньше 8 символов.');
  }

  const result = await writeProviderSecret(name.trim().toLowerCase(), apiKey);
  if (result.state !== 'ok' || !result.data) {
    return jsonError(result.status === 400 ? 400 : 502, 'core_unavailable', result.message ?? 'Ядро не приняло ключ.');
  }
  await recordAudit(auth.user, 'provider.secret.write', { type: 'provider', id: name.trim().toLowerCase() }, {
    length: apiKey.length,
  });
  return jsonOk({ provider: result.data.provider, llm_rebound: result.data.llm_rebound ?? null });
}

// Убрать ключ: провайдер остаётся, но без доступа.
export async function DELETE(request: Request, context: { params: Promise<{ name: string }> }) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const { name } = await context.params;
  if (!isValidProviderName(name)) {
    return jsonError(400, 'invalid_provider', 'Некорректное имя провайдера.');
  }
  const result = await deleteProviderSecret(name.trim().toLowerCase());
  if (result.state !== 'ok' || !result.data) {
    return jsonError(502, 'core_unavailable', result.message ?? 'Ядро не убрало ключ.');
  }
  await recordAudit(auth.user, 'provider.secret.delete', { type: 'provider', id: name.trim().toLowerCase() }, {
    removed: Boolean(result.data.removed),
  });
  return jsonOk(result.data);
}
