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

  // If base_url was not supplied in the request body, look up the existing provider from core
  if (!baseUrl) {
    const listRes = await readProviders();
    if (listRes.state === 'ok' && listRes.data?.providers) {
      const match = listRes.data.providers.find(
        (p: ProviderRow) => p.name.toLowerCase() === cleanName,
      );
      if (match) {
        baseUrl = match.base_url;
        kind = match.kind || 'openai';
      }
    }
  }

  if (!baseUrl || !isValidBaseUrl(baseUrl)) {
    return jsonError(400, 'invalid_url', 'Не указан корректный base_url для проверки.');
  }

  // Parse URL & validate protocol
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    return jsonError(400, 'invalid_url', 'Невозможно разобрать base_url.');
  }

  const isLocalhost =
    parsedUrl.hostname === 'localhost' ||
    parsedUrl.hostname === '127.0.0.1' ||
    parsedUrl.hostname === '::1';
  let warning: string | undefined;

  if (parsedUrl.protocol !== 'https:' && !isLocalhost) {
    warning = 'Используется незащищённое соединение HTTP для удалённого сервера.';
  }

  // Build target endpoint URL
  // Strip trailing slashes
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
    });

    const latencyMs = Date.now() - startTime;

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
        message: `Сервер вернул статус ${response.status} (${response.statusText}).`,
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

    const message =
      err instanceof Error ? err.message : 'Не удалось связаться с сервером.';
    return Response.json({
      ok: false,
      error: 'unreachable',
      message: `Сервер недоступен или адрес указан неверно (${message}).`,
      latency_ms: latencyMs,
      warning,
    });
  }
}
