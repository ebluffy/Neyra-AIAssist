import { lookup } from 'node:dns/promises';
import { requireAdmin } from '../../../../../../../lib/admin-guard';
import { readProviders, isValidBaseUrl, isValidProviderName, type ProviderRow } from '../../../../../../../lib/admin-providers';
import { jsonError, readJson } from '../../../../../../../lib/admin-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface VerifyRequestBody {
  base_url?: string;
  api_key?: string;
}

interface ModelItem {
  id: string;
  name?: string;
}

// AR-70: с сервера сайта нельзя ходить в свою же внутреннюю сеть, даже админом.
// Локальные провайдеры разрешены только по явному имени: они и так живут рядом с хостом.
const LOCAL_PROVIDER_NAMES = new Set(['ollama', 'vllm', 'lmstudio', 'local']);

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^0\./,
];

function isPrivateAddress(address: string): boolean {
  const value = address.trim().toLowerCase();
  if (!value) return true;
  if (value === '::1' || value === '::' || value === '0.0.0.0') return true;
  if (value.startsWith('fe80:') || value.startsWith('fc') || value.startsWith('fd')) return true;
  if (value.startsWith('::ffff:')) return isPrivateAddress(value.slice(7));
  return PRIVATE_V4.some((re) => re.test(value));
}

interface TargetCheck {
  ok: boolean;
  message?: string;
}

async function checkTarget(url: URL, allowLocal: boolean): Promise<TargetCheck> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, message: 'Проверка поддерживает только http и https.' };
  }
  let addresses: string[];
  try {
    const resolved = await lookup(url.hostname, { all: true, verbatim: true });
    addresses = resolved.map((item) => item.address);
  } catch {
    return { ok: false, message: 'Не удалось определить адрес сервера.' };
  }
  if (addresses.length === 0) return { ok: false, message: 'Не удалось определить адрес сервера.' };
  const blocked = addresses.filter((address) => {
    if (allowLocal) {
      // Даже для локального провайдера metadata-адреса и link-local запрещены.
      const value = address.toLowerCase();
      return value.startsWith('169.254.') || value.startsWith('fe80:') || value === '0.0.0.0';
    }
    return isPrivateAddress(address);
  });
  if (blocked.length > 0) {
    return { ok: false, message: 'Адрес ведёт во внутреннюю сеть; проверка таких адресов запрещена.' };
  }
  return { ok: true };
}

export async function POST(
  request: Request,
  context: { params: Promise<{ name: string }> },
) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;

  const { name } = await context.params;
  const cleanName = (name ?? '').trim().toLowerCase();
  if (!isValidProviderName(cleanName)) {
    return jsonError(400, 'invalid_provider', 'Некорректное имя провайдера.');
  }

  const body = (await readJson(request)) as VerifyRequestBody | null;
  const rawBaseUrl = typeof body?.base_url === 'string' ? body.base_url.trim() : '';
  const candidateKey = typeof body?.api_key === 'string' ? body.api_key.trim() : '';

  let baseUrl = rawBaseUrl;
  let kind = 'openai';
  let savedProvider: ProviderRow | null = null;

  // If base_url was not supplied in the request body, look up the existing provider from core
  if (!baseUrl) {
    const listRes = await readProviders();
    if (listRes.state === 'ok' && listRes.data?.providers) {
      const match = listRes.data.providers.find(
        (p: ProviderRow) => p.name.toLowerCase() === cleanName,
      );
      if (match) {
        savedProvider = match;
        baseUrl = match.base_url;
        kind = match.kind || 'openai';
      }
    }
  }

  if (!baseUrl || !isValidBaseUrl(baseUrl)) {
    return jsonError(400, 'invalid_url', 'Не указан корректный base_url для проверки.');
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    return jsonError(400, 'invalid_url', 'Невозможно разобрать base_url.');
  }

  // AR-69: ключ сохранённого провайдера лежит в vault ядра. Сайт его не знает,
  // поэтому проверка без введённого ключа честно говорит об этом, а не «неверный ключ».
  if (!candidateKey && savedProvider?.has_key) {
    const probe = savedProvider.probe;
    if (probe && probe.state === 'open') {
      return Response.json({
        ok: true,
        models_count: probe.models ?? 0,
        message: probe.message || 'Соединение проверено ядром.',
        source: 'core_probe',
      });
    }
    if (probe && probe.state === 'unreachable') {
      return Response.json({
        ok: false,
        error: 'unreachable',
        message: probe.message || 'Ядро не смогло связаться с провайдером.',
        source: 'core_probe',
      });
    }
    return Response.json({
      ok: false,
      error: 'key_in_core',
      message: 'Ключ сохранён в ядре: сайт не может проверить его без повторного ввода. Введите ключ заново или смотрите статус в списке провайдеров.',
      source: 'core_probe',
    });
  }

  const allowLocal = LOCAL_PROVIDER_NAMES.has(cleanName) || LOCAL_PROVIDER_NAMES.has(kind);
  const targetCheck = await checkTarget(parsedUrl, allowLocal);
  if (!targetCheck.ok) {
    return Response.json({
      ok: false,
      error: 'blocked_target',
      message: targetCheck.message,
    });
  }

  let warning: string | undefined;
  if (parsedUrl.protocol !== 'https:' && !allowLocal) {
    warning = 'Используется незащищённое соединение HTTP для удалённого сервера.';
  }

  const cleanBase = baseUrl.replace(/\/+$/, '');
  const targetEndpoint = `${cleanBase}/models`;

  const headers: Record<string, string> = {
    Accept: 'application/json',
  };

  const isAnthropic = cleanName.includes('anthropic') || kind === 'anthropic';

  if (candidateKey) {
    if (isAnthropic) {
      headers['x-api-key'] = candidateKey;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers['Authorization'] = `Bearer ${candidateKey}`;
    }
  }

  const startTime = Date.now();
  try {
    const response = await fetch(targetEndpoint, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(8000),
      cache: 'no-store',
      redirect: 'manual',
    });

    const latencyMs = Date.now() - startTime;

    if (response.status >= 300 && response.status < 400) {
      return Response.json({
        ok: false,
        error: 'redirect',
        message: 'Сервер ответил перенаправлением; такие ответы не проверяются.',
        status_code: response.status,
        latency_ms: latencyMs,
      });
    }

    if (response.status === 401 || response.status === 403) {
      return Response.json({
        ok: false,
        error: 'unauthorized',
        message: 'Неверный API-ключ или доступ запрещён (401/403).',
        status_code: response.status,
        latency_ms: latencyMs,
        warning,
      });
    }

    if (!response.ok) {
      return Response.json({
        ok: false,
        error: 'unreachable',
        message: `Сервер вернул статус ${response.status}.`,
        status_code: response.status,
        latency_ms: latencyMs,
        warning,
      });
    }

    const json = await response.json().catch(() => null);
    const models: ModelItem[] = [];

    if (json && typeof json === 'object') {
      if (Array.isArray(json.data)) {
        // OpenAI standard format: { data: [{ id: "...", ... }] }
        for (const item of json.data) {
          if (item && typeof item === 'object' && typeof item.id === 'string') {
            models.push({ id: item.id, name: item.name || item.id });
          }
        }
      } else if (Array.isArray(json.models)) {
        // Ollama / custom format: { models: [{ name: "...", ... }] }
        for (const item of json.models) {
          if (item && typeof item === 'object') {
            const id = item.name || item.id || item.model;
            if (typeof id === 'string') {
              models.push({ id, name: item.name || id });
            }
          }
        }
      } else if (Array.isArray(json)) {
        for (const item of json) {
          if (typeof item === 'string') {
            models.push({ id: item, name: item });
          } else if (item && typeof item === 'object' && typeof item.id === 'string') {
            models.push({ id: item.id, name: item.name || item.id });
          }
        }
      }
    }

    return Response.json({
      ok: true,
      models_count: models.length,
      latency_ms: latencyMs,
      models,
      warning,
    });
  } catch (err: unknown) {
    const latencyMs = Date.now() - startTime;
    const isTimeout =
      (err instanceof Error && err.name === 'TimeoutError') ||
      (err instanceof Error && err.name === 'AbortError') ||
      latencyMs >= 7900;

    if (isTimeout) {
      return Response.json({
        ok: false,
        error: 'timeout',
        message: 'Превышено время ожидания ответа сервера (8 секунд).',
        latency_ms: latencyMs,
        warning,
      });
    }

    // AR-70: текст исключения клиенту не отдаём.
    return Response.json({
      ok: false,
      error: 'unreachable',
      message: 'Сервер недоступен или адрес указан неверно.',
      latency_ms: latencyMs,
      warning,
    });
  }
}
