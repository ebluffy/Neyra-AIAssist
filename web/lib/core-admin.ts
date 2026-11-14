// Клиент ядра для админки. Сайт ходит в ядро только с сервера, ключ (NEYRA_SERVICE_KEY)
// никогда не покидает сервер и не попадает в ответы API.
// Разделы настроек ядра в волне 2 — только чтение; отсутствие API показывается честно.

export type CoreState = 'ok' | 'unconfigured' | 'unauthorized' | 'unavailable' | 'error';

export interface CoreResult<T> {
  state: CoreState;
  data: T | null;
  message?: string;
  /** HTTP status from the core, when it answered. Kept so routes can map 400 vs 5xx. */
  status?: number;
}

export interface CoreEnv {
  url: string;
  token: string;
}

export type Environment = Record<string, string | undefined>;

export function readCoreEnv(env: Environment = process.env): CoreEnv | null {
  const url = (env.NEYRA_API_URL ?? '').trim().replace(/\/+$/, '');
  const token = (env.NEYRA_SERVICE_KEY ?? '').trim();
  if (!url || !token) return null;
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
  } catch {
    return null;
  }
  return { url, token };
}

const UNCONFIGURED: CoreResult<never> = {
  state: 'unconfigured',
  data: null,
  message: 'Ядро не подключено: в .env сайта нет NEYRA_API_URL и NEYRA_SERVICE_KEY.',
};

interface CoreRequest {
  env?: Environment;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Statuses whose body is still meaningful, e.g. /v1/health/ready answers 503 with checks. */
  acceptStatus?: number[];
}

async function request<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  options: CoreRequest & { body?: unknown } = {},
): Promise<CoreResult<T>> {
  const env = readCoreEnv(options.env ?? process.env);
  if (!env) return { ...UNCONFIGURED };
  const doFetch = options.fetchImpl ?? fetch;
  try {
    const response = await doFetch(`${env.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${env.token}`,
        accept: 'application/json',
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
      cache: 'no-store',
    });
    if (response.status === 401 || response.status === 403) {
      return {
        state: 'unauthorized',
        data: null,
        status: response.status,
        message: `Ядро отклонило ключ сайта (${response.status}).`,
      };
    }
    const payload = await response.json().catch(() => null) as { ok?: boolean; data?: unknown; error?: { message?: string } } | null;
    const accepted = Boolean(options.acceptStatus?.includes(response.status));
    if (!response.ok && accepted) {
      const acceptedData = payload && typeof payload === 'object' && 'data' in payload ? payload.data : payload;
      return { state: 'ok', data: (acceptedData ?? null) as T, status: response.status };
    }
    if (!response.ok) {
      return {
        state: 'error',
        data: null,
        status: response.status,
        message: payload?.error?.message ?? `Ядро ответило ${response.status}.`,
      };
    }
    if (payload && payload.ok === false) {
      return {
        state: 'error',
        data: null,
        status: response.status,
        message: payload.error?.message ?? 'Ядро вернуло ошибку.',
      };
    }
    const data = payload && typeof payload === 'object' && 'data' in payload ? payload.data : payload;
    // status нужен вызывающим: /v1/health/ready с 200 — «готово», с 503 — «не готово».
    return { state: 'ok', data: (data ?? null) as T, status: response.status };
  } catch (error) {
    const reason = error instanceof Error && error.name === 'TimeoutError'
      ? 'Ядро не ответило вовремя.'
      : 'Ядро недоступно.';
    return { state: 'unavailable', data: null, message: reason };
  }
}

export function coreGet<T>(path: string, options: CoreRequest = {}): Promise<CoreResult<T>> {
  return request<T>('GET', path, options);
}

// /v1/health/ready отвечает 503, когда не готов, но тело с checks остаётся полезным.
export function coreGetReady<T>(path: string, options: CoreRequest = {}): Promise<CoreResult<T>> {
  return request<T>('GET', path, { ...options, acceptStatus: [200, 503] });
}

export function corePost<T>(path: string, body: unknown, options: CoreRequest = {}): Promise<CoreResult<T>> {
  return request<T>('POST', path, { ...options, body });
}

export function corePut<T>(path: string, body: unknown, options: CoreRequest = {}): Promise<CoreResult<T>> {
  return request<T>('PUT', path, { ...options, body });
}

export function coreDelete<T>(path: string, options: CoreRequest = {}): Promise<CoreResult<T>> {
  return request<T>('DELETE', path, options);
}

export interface CoreHealth {
  ok?: boolean;
  status?: string;
  version?: string;
  api_version?: string;
  uptime_seconds?: number;
  checks?: Array<{ name?: string; ok?: boolean; ms?: number; reason?: string }>;
  llm_providers?: string[];
  // Объект {error_class, at}, а не строка: тип не должен врать.
  degraded_reason?: unknown;
  [key: string]: unknown;
}

export interface CoreMeta {
  api_version?: string;
  public_url?: string | null;
  dashboard_url?: string | null;
  features?: Record<string, boolean>;
  [key: string]: unknown;
}

export interface CoreModelRoles {
  roles?: Record<string, { role?: string; provider?: string; model?: string }>;
  [key: string]: unknown;
}
