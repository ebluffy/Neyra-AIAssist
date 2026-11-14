import { requireAdmin } from '../../../../../../lib/admin-guard';
import {
  deleteProvider,
  isValidBaseUrl,
  isValidProviderName,
  migrateProviderSecret,
  writeProvider,
} from '../../../../../../lib/admin-providers';
import { recordAudit } from '../../../../../../lib/admin-audit';
import { jsonError, jsonOk, readJson } from '../../../../../../lib/admin-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KINDS = new Set(['openai', 'local', 'proxy']);

// Создать или обновить провайдера: имя, base_url, вид. Ключ — отдельным маршрутом.
export async function PUT(request: Request, context: { params: Promise<{ name: string }> }) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const { name } = await context.params;
  if (!isValidProviderName(name)) {
    return jsonError(400, 'invalid_provider', 'Имя провайдера: строчные латинские буквы, цифры, . _ -');
  }
  const body = await readJson(request);
  const raw = (body ?? {}) as { base_url?: unknown; kind?: unknown };
  const baseUrl = typeof raw.base_url === 'string' ? raw.base_url.trim() : '';
  if (!isValidBaseUrl(baseUrl)) {
    return jsonError(400, 'invalid_base_url', 'base_url должен начинаться с http:// или https://');
  }
  const kind = typeof raw.kind === 'string' && KINDS.has(raw.kind) ? raw.kind : 'openai';

  const result = await writeProvider(name.trim().toLowerCase(), { base_url: baseUrl, kind });
  if (result.state === 'unsupported') {
    return jsonOk({ supported: false, message: result.message ?? 'Ядро не поддерживает управление провайдерами.' });
  }
  if (result.state !== 'ok' || !result.data) {
    return jsonError(
      result.status === 400 ? 400 : 502,
      result.state === 'error' ? 'invalid_provider' : 'core_unavailable',
      result.message ?? 'Ядро не приняло провайдера.',
    );
  }
  await recordAudit(auth.user, 'provider.write', { type: 'provider', id: name.trim().toLowerCase() }, {
    base_url: baseUrl,
    kind,
  });
  return jsonOk(result.data);
}

// Удалить провайдера: ядро откажет, если им пользуется лейн.
export async function DELETE(request: Request, context: { params: Promise<{ name: string }> }) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const { name } = await context.params;
  if (!isValidProviderName(name)) {
    return jsonError(400, 'invalid_provider', 'Некорректное имя провайдера.');
  }
  const result = await deleteProvider(name.trim().toLowerCase());
  if (result.state === 'unsupported') {
    return jsonOk({ supported: false, message: result.message ?? 'Ядро не поддерживает управление провайдерами.' });
  }
  if (result.state !== 'ok' || !result.data) {
    const conflict = result.status === 409;
    return jsonError(
      conflict ? 409 : 502,
      conflict ? 'provider_in_use' : 'core_unavailable',
      result.message ?? 'Ядро не удалило провайдера.',
    );
  }
  await recordAudit(auth.user, 'provider.delete', { type: 'provider', id: name.trim().toLowerCase() }, {
    key_removed: Boolean(result.data.key_removed),
  });
  return jsonOk(result.data);
}

// Перенос ключа из config/llm.yaml в шифрованное хранилище ядра.
export async function POST(request: Request, context: { params: Promise<{ name: string }> }) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const { name } = await context.params;
  if (!isValidProviderName(name)) {
    return jsonError(400, 'invalid_provider', 'Некорректное имя провайдера.');
  }
  const result = await migrateProviderSecret(name.trim().toLowerCase());
  if (result.state === 'unsupported') {
    return jsonOk({ supported: false, message: result.message ?? 'Ядро не поддерживает управление провайдерами.' });
  }
  if (result.state !== 'ok' || !result.data) {
    return jsonError(result.status === 400 ? 400 : 502, 'core_unavailable', result.message ?? 'Ядро не перенесло ключ.');
  }
  await recordAudit(auth.user, 'provider.secret.migrate', { type: 'provider', id: name.trim().toLowerCase() }, {
    source: 'yaml',
  });
  return jsonOk(result.data);
}
