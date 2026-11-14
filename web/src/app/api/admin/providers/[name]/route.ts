import { requireAdmin } from '../../../../../../lib/admin-guard';
import {
  deleteProvider,
  isProviderType,
  isValidBaseUrl,
  isValidProviderName,
  migrateProviderSecret,
  writeProvider,
  type ProviderFieldValue,
} from '../../../../../../lib/admin-providers';
import { recordAudit } from '../../../../../../lib/admin-audit';
import { jsonError, jsonOk, readJson } from '../../../../../../lib/admin-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KINDS = new Set(['openai', 'local', 'proxy']);
const FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,40}$/;
const MAX_FIELDS = 30;

function readFields(value: unknown): { ok: true; fields: Record<string, ProviderFieldValue> } | { ok: false; message: string } {
  if (value == null) return { ok: true, fields: {} };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, message: 'Поля провайдера должны быть объектом.' };
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_FIELDS) {
    return { ok: false, message: 'Слишком много полей провайдера.' };
  }
  const fields: Record<string, ProviderFieldValue> = {};
  for (const [key, raw] of entries) {
    if (!FIELD_KEY_RE.test(key)) {
      return { ok: false, message: `Некорректное имя поля: ${key}` };
    }
    if (typeof raw === 'boolean') {
      fields[key] = raw;
    } else if (typeof raw === 'number' && Number.isFinite(raw)) {
      fields[key] = raw;
    } else if (typeof raw === 'string' && raw.length <= 300) {
      fields[key] = raw.trim();
    } else {
      return { ok: false, message: `Некорректное значение поля: ${key}` };
    }
  }
  return { ok: true, fields };
}

// Создать или обновить провайдера: имя, base_url, вид и несекретные поля.
// Ключ — отдельным маршрутом и только в vault.
export async function PUT(request: Request, context: { params: Promise<{ name: string }> }) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const { name } = await context.params;
  if (!isValidProviderName(name)) {
    return jsonError(400, 'invalid_provider', 'Имя провайдера: строчные латинские буквы, цифры, . _ -');
  }
  const body = await readJson(request);
  const raw = (body ?? {}) as {
    base_url?: unknown;
    kind?: unknown;
    preset?: unknown;
    provider_type?: unknown;
    fields?: unknown;
  };
  const baseUrl = typeof raw.base_url === 'string' ? raw.base_url.trim() : '';
  if (!isValidBaseUrl(baseUrl)) {
    return jsonError(400, 'invalid_base_url', 'base_url должен начинаться с http:// или https://');
  }
  const kind = typeof raw.kind === 'string' && KINDS.has(raw.kind) ? raw.kind : 'openai';
  const preset =
    typeof raw.preset === 'string' && isValidProviderName(raw.preset)
      ? raw.preset.trim().toLowerCase()
      : undefined;
  const providerType = isProviderType(raw.provider_type) ? raw.provider_type : undefined;
  const parsedFields = readFields(raw.fields);
  if (parsedFields.ok === false) {
    return jsonError(400, 'invalid_field', parsedFields.message);
  }

  const result = await writeProvider(name.trim().toLowerCase(), {
    base_url: baseUrl,
    kind,
    preset,
    provider_type: providerType,
    fields: parsedFields.fields,
  });
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
    preset: preset ?? null,
    provider_type: providerType ?? null,
    field_keys: Object.keys(parsedFields.fields).join(','),
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
  if (result.state !== 'ok' || !result.data) {
    return jsonError(result.status === 400 ? 400 : 502, 'core_unavailable', result.message ?? 'Ядро не перенесло ключ.');
  }
  await recordAudit(auth.user, 'provider.secret.migrate', { type: 'provider', id: name.trim().toLowerCase() }, {
    source: 'yaml',
  });
  return jsonOk(result.data);
}
