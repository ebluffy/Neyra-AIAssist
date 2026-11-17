import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { requireAdmin } from '../../../../../../../lib/admin-guard';
import { readProviders, isValidBaseUrl, isValidProviderName, type ProviderRow } from '../../../../../../../lib/admin-providers';
import { jsonError, readJson } from '../../../../../../../lib/admin-http';
import { executePinnedProbe } from '../../../../../../../lib/admin-probe';

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
// Локальные провайдеры разрешены только если они уже сохранены в ядре с этим же base_url.
const LOCAL_PROVIDER_NAMES = new Set(['ollama', 'vllm', 'lmstudio', 'local']);

const PRIVATE_BLOCKLIST = new BlockList();
// IPv4 loopback & private & link-local & CGNAT & multicast & reserved
PRIVATE_BLOCKLIST.addSubnet('127.0.0.0', 8, 'ipv4');
PRIVATE_BLOCKLIST.addSubnet('10.0.0.0', 8, 'ipv4');
PRIVATE_BLOCKLIST.addSubnet('172.16.0.0', 12, 'ipv4');
PRIVATE_BLOCKLIST.addSubnet('192.168.0.0', 16, 'ipv4');
PRIVATE_BLOCKLIST.addSubnet('169.254.0.0', 16, 'ipv4');
PRIVATE_BLOCKLIST.addSubnet('0.0.0.0', 8, 'ipv4');
PRIVATE_BLOCKLIST.addSubnet('100.64.0.0', 10, 'ipv4');
PRIVATE_BLOCKLIST.addSubnet('198.18.0.0', 15, 'ipv4');
PRIVATE_BLOCKLIST.addSubnet('224.0.0.0', 4, 'ipv4');
PRIVATE_BLOCKLIST.addSubnet('240.0.0.0', 4, 'ipv4');
PRIVATE_BLOCKLIST.addAddress('255.255.255.255', 'ipv4');

// IPv6 loopback & unspecified & unique local & link-local & multicast
PRIVATE_BLOCKLIST.addAddress('::1', 'ipv6');
PRIVATE_BLOCKLIST.addAddress('::', 'ipv6');
PRIVATE_BLOCKLIST.addSubnet('fc00::', 7, 'ipv6');
PRIVATE_BLOCKLIST.addSubnet('fe80::', 10, 'ipv6');
PRIVATE_BLOCKLIST.addSubnet('ff00::', 8, 'ipv6');

function normalizeIp(address: string): { ip: string; version: 'ipv4' | 'ipv6' } | null {
  let clean = address.trim().toLowerCase();
  if (clean.startsWith('[') && clean.endsWith(']')) {
    clean = clean.slice(1, -1);
  }
  if (clean.startsWith('::ffff:')) {
    const rest = clean.slice(7);
    if (isIP(rest) === 4) {
      return { ip: rest, version: 'ipv4' };
    }
    const parts = rest.split(':');
    if (parts.length === 2) {
      const p1 = parseInt(parts[0], 16);
      const p2 = parseInt(parts[1], 16);
      if (!Number.isNaN(p1) && !Number.isNaN(p2) && p1 >= 0 && p1 <= 0xffff && p2 >= 0 && p2 <= 0xffff) {
        const b1 = (p1 >> 8) & 0xff;
        const b2 = p1 & 0xff;
        const b3 = (p2 >> 8) & 0xff;
        const b4 = p2 & 0xff;
        return { ip: `${b1}.${b2}.${b3}.${b4}`, version: 'ipv4' };
      }
    }
  }
  const v = isIP(clean);
  if (v === 4) return { ip: clean, version: 'ipv4' };
  if (v === 6) return { ip: clean, version: 'ipv6' };
  return null;
}

function isBlockedAddress(address: string, allowLocal: boolean): boolean {
  const norm = normalizeIp(address);
  if (!norm) return true;
  if (allowLocal) {
    // Даже для локального сохранённого провайдера metadata-адреса, link-local и 0.0.0.0 запрещены.
    if (norm.ip === '0.0.0.0' || norm.ip === '::') return true;
    if (norm.version === 'ipv4' && (norm.ip.startsWith('169.254.') || norm.ip.startsWith('0.'))) return true;
    if (norm.version === 'ipv6' && norm.ip.startsWith('fe80:')) return true;
    return false;
  }
  return PRIVATE_BLOCKLIST.check(norm.ip, norm.version);
}

interface TargetResolution {
  ok: boolean;
  message?: string;
  pinnedAddresses?: Array<{ address: string; family: number }>;
}

async function resolveAndCheckTarget(url: URL, allowLocal: boolean): Promise<TargetResolution> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, message: 'Проверка поддерживает только http и https.' };
  }
  let resolved: Array<{ address: string; family: number }>;
  try {
    resolved = await lookup(url.hostname, { all: true, verbatim: true });
  } catch {
    return { ok: false, message: 'Не удалось определить адрес сервера.' };
  }
  if (!resolved || resolved.length === 0) {
    return { ok: false, message: 'Не удалось определить адрес сервера.' };
  }

  const pinned: Array<{ address: string; family: number }> = [];
  for (const item of resolved) {
    if (isBlockedAddress(item.address, allowLocal)) {
      return { ok: false, message: 'Адрес ведёт во внутреннюю сеть; проверка таких адресов запрещена.' };
    }
    const norm = normalizeIp(item.address);
    if (norm) {
      pinned.push({ address: norm.ip, family: norm.version === 'ipv4' ? 4 : 6 });
    }
  }
  return { ok: true, pinnedAddresses: pinned.length > 0 ? pinned : resolved };
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

  // AR-69: сохранённого провайдера ищем ВСЕГДА, чтобы знать, есть ли ключ в vault ядра
  const listRes = await readProviders();
  if (listRes.state === 'ok' && listRes.data?.providers) {
    const match = listRes.data.providers.find(
      (p: ProviderRow) => p.name.toLowerCase() === cleanName,
    );
    if (match) {
      savedProvider = match;
      if (!baseUrl) {
        baseUrl = match.base_url;
      }
      kind = match.kind || 'openai';
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

  // AR-70: allowLocal разрешён ТОЛЬКО если сохранённый в ядре провайдер имеет локальный тип
  // И его собственный base_url совпадает с проверяемым origin.
  // Имя в URL или теле запроса не может включить allowLocal для произвольного хоста.
  let allowLocal = false;
  if (savedProvider) {
    const savedKind = (savedProvider.kind || '').toLowerCase();
    const savedName = savedProvider.name.toLowerCase();
    const isLocalKind = LOCAL_PROVIDER_NAMES.has(savedKind) || LOCAL_PROVIDER_NAMES.has(savedName);
    if (isLocalKind && savedProvider.base_url) {
      try {
        const savedOrigin = new URL(savedProvider.base_url).origin.toLowerCase();
        if (parsedUrl.origin.toLowerCase() === savedOrigin) {
          allowLocal = true;
        }
      } catch {
        // invalid URL
      }
    }
  }

  const targetCheck = await resolveAndCheckTarget(parsedUrl, allowLocal);
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

  // Pinned DNS lookup dispatcher to prevent DNS rebinding attacks
  const pinnedList = targetCheck.pinnedAddresses ?? [];

  const startTime = Date.now();
  try {
    const probe = await executePinnedProbe(targetEndpoint, headers, pinnedList, 8000);

    const latencyMs = Date.now() - startTime;

    if (probe.status >= 300 && probe.status < 400) {
      return Response.json({
        ok: false,
        error: 'redirect',
        message: 'Сервер ответил перенаправлением; такие ответы не проверяются.',
        status_code: probe.status,
        latency_ms: latencyMs,
      });
    }

    if (probe.status === 401 || probe.status === 403) {
      return Response.json({
        ok: false,
        error: 'unauthorized',
        message: 'Неверный API-ключ или доступ запрещён (401/403).',
        status_code: probe.status,
        latency_ms: latencyMs,
        warning,
      });
    }

    if (!probe.ok) {
      return Response.json({
        ok: false,
        error: 'unreachable',
        message: `Сервер вернул статус ${probe.status}.`,
        status_code: probe.status,
        latency_ms: latencyMs,
        warning,
      });
    }

    // AR-89: если статус 200, но тело не является корректным JSON, возвращаем bad_response
    if (probe.status === 200 && probe.json === null) {
      return Response.json({
        ok: false,
        error: 'bad_response',
        message: 'Сервер вернул статус 200, но ответ не является корректным JSON.',
        status_code: 200,
        latency_ms: latencyMs,
        warning,
      });
    }

    const json = probe.json as Record<string, unknown> | unknown[] | null;
    const models: ModelItem[] = [];

    if (json && typeof json === 'object') {
      const record = json as Record<string, unknown>;
      if (Array.isArray(record.data)) {
        // OpenAI standard format: { data: [{ id: "...", ... }] }
        for (const item of record.data) {
          if (item && typeof item === 'object' && typeof item.id === 'string') {
            models.push({ id: item.id, name: item.name || item.id });
          }
        }
      } else if (Array.isArray(record.models)) {
        // Ollama / custom format: { models: [{ name: "...", ... }] }
        for (const item of record.models) {
          if (item && typeof item === 'object') {
            const itemObj = item as Record<string, unknown>;
            const id = (itemObj.name || itemObj.id || itemObj.model) as string | undefined;
            if (typeof id === 'string') {
              models.push({ id, name: (itemObj.name as string) || id });
            }
          }
        }
      } else if (Array.isArray(json)) {
        for (const item of json) {
          if (typeof item === 'string') {
            models.push({ id: item, name: item });
          } else if (item && typeof item === 'object') {
            const itemObj = item as Record<string, unknown>;
            if (typeof itemObj.id === 'string') {
              models.push({ id: itemObj.id, name: (itemObj.name as string) || itemObj.id });
            }
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
