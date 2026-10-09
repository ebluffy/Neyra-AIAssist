const SESSION_TOKEN_KEY = 'neyra_dashboard_session'
/** Legacy key — never read/write; purged on load. */
const LEGACY_TOKEN_KEY = 'neyra_api_token'
const DEFAULT_TIMEOUT_MS = 30_000

/** Memory-only API token override (Settings). Never persisted to localStorage. */
let memoryApiToken = ''

try {
  localStorage.removeItem(LEGACY_TOKEN_KEY)
} catch {
  /* ignore */
}

export function clearToken(): void {
  memoryApiToken = ''
  try {
    localStorage.removeItem(LEGACY_TOKEN_KEY)
  } catch {
    /* ignore */
  }
}

/** Clear dashboard session only. */
export function clearSessionToken(): void {
  sessionStorage.removeItem(SESSION_TOKEN_KEY)
}

/** Memory-only API token from Settings (not localStorage). */
export function getStoredApiToken(): string {
  return memoryApiToken
}

export function getToken(): string {
  const session = sessionStorage.getItem(SESSION_TOKEN_KEY)?.trim()
  if (session) return session
  return memoryApiToken.trim()
}

/** Set memory-only API token override (Settings). Empty clears. */
export function setToken(t: string): void {
  memoryApiToken = t.trim()
}

/** Session Bearer from gate login — sessionStorage only. */
export function setSessionToken(t: string): void {
  const s = t.trim()
  if (s) sessionStorage.setItem(SESSION_TOKEN_KEY, s)
  else sessionStorage.removeItem(SESSION_TOKEN_KEY)
}

export function getSessionToken(): string {
  return sessionStorage.getItem(SESSION_TOKEN_KEY)?.trim() ?? ''
}

export function hasDashboardSession(): boolean {
  return Boolean(getSessionToken())
}

function headers(): HeadersInit {
  const h: Record<string, string> = { Accept: 'application/json' }
  const tok = getToken().trim()
  if (tok) h.Authorization = `Bearer ${tok}`
  return h
}

function jsonHeaders(): HeadersInit {
  return { ...headers(), 'Content-Type': 'application/json' }
}

/** Expired/revoked dashboard session → clear and reopen gate (once). */
let sessionExpiredRedirect = false

function redirectToLoginOnSession401(status: number): void {
  if (status !== 401 || sessionExpiredRedirect) return
  if (!getSessionToken()) return
  sessionExpiredRedirect = true
  clearSessionToken()
  window.location.assign('/')
}

function parseRetryAfter(r: Response): number | undefined {
  const raw = r.headers.get('Retry-After')
  if (!raw) return undefined
  const sec = Number(raw)
  if (Number.isFinite(sec) && sec >= 0) return sec
  const when = Date.parse(raw)
  if (!Number.isNaN(when)) {
    const s = Math.ceil((when - Date.now()) / 1000)
    return s >= 0 ? s : undefined
  }
  return undefined
}

function extractTraceId(body: unknown, r: Response): string {
  const header =
    r.headers.get('x-trace-id') ||
    r.headers.get('x-request-id') ||
    r.headers.get('traceparent') ||
    ''
  if (header) return header
  if (body && typeof body === 'object') {
    const o = body as Record<string, unknown>
    const err = o.error
    if (err && typeof err === 'object') {
      const e = err as Record<string, unknown>
      if (typeof e.trace_id === 'string') return e.trace_id
    }
    if (typeof o.trace_id === 'string') return o.trace_id
  }
  return ''
}

/** Error from the API; `.status` / `.code` / `.trace_id` / `.retryAfter` for callers. */
export class ApiRequestError extends Error {
  status: number
  code: string
  trace_id: string
  retryAfter?: number

  constructor(
    message: string,
    status: number,
    code = '',
    trace_id = '',
    retryAfter?: number,
  ) {
    super(message)
    this.name = 'ApiRequestError'
    this.status = status
    this.code = code
    this.trace_id = trace_id
    this.retryAfter = retryAfter
  }
}

type FetchOpts = {
  method?: string
  body?: BodyInit | null
  headers?: HeadersInit
  timeoutMs?: number
  signal?: AbortSignal
}

async function apiFetch(path: string, opts: FetchOpts = {}): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const ctrl = new AbortController()
  const timer = window.setTimeout(() => ctrl.abort(), timeoutMs)
  const onOuterAbort = () => ctrl.abort()
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort()
    else opts.signal.addEventListener('abort', onOuterAbort, { once: true })
  }
  try {
    return await fetch(path, {
      method: opts.method,
      headers: opts.headers,
      body: opts.body,
      signal: ctrl.signal,
    })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new ApiRequestError('Таймаут запроса', 0, 'timeout', '')
    }
    throw e
  } finally {
    window.clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onOuterAbort)
  }
}

async function parseApiResponse<T>(r: Response): Promise<T> {
  const text = await r.text()
  const trimmed = text.trimStart()
  if (trimmed.startsWith('<') || trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<!doctype')) {
    throw new ApiRequestError(
      r.status >= 500 || r.status === 0
        ? `Сервер недоступен (HTTP ${r.status || '—'}). Подождите конца перезапуска или обновите страницу.`
        : `Ответ не JSON (HTTP ${r.status}) — сервер перезапускается или прокси вернул HTML.`,
      r.status,
      'non_json',
      r.headers.get('x-trace-id') || '',
      parseRetryAfter(r),
    )
  }
  type Body = T & {
    ok?: boolean
    error?: { message?: string; code?: string; trace_id?: string }
    trace_id?: string
  }
  let j: Body
  try {
    j = JSON.parse(text) as Body
  } catch {
    throw new ApiRequestError(
      `Не удалось разобрать ответ API (HTTP ${r.status})`,
      r.status,
      'parse_error',
      r.headers.get('x-trace-id') || '',
    )
  }
  const traceId = extractTraceId(j, r)
  const retryAfter = parseRetryAfter(r)
  if (!r.ok) {
    redirectToLoginOnSession401(r.status)
    const msg = j?.error?.message ?? r.statusText
    throw new ApiRequestError(
      msg || `HTTP ${r.status}`,
      r.status,
      j?.error?.code ?? '',
      traceId,
      retryAfter,
    )
  }
  if (j && typeof j === 'object' && 'ok' in j && j.ok === false) {
    const msg = j.error?.message ?? 'API error'
    throw new ApiRequestError(msg, r.status, j.error?.code ?? '', traceId, retryAfter)
  }
  return j as T
}

export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const r = await apiFetch(path, { headers: headers(), signal })
  return parseApiResponse<T>(r)
}

export async function apiGetText(path: string, signal?: AbortSignal): Promise<string> {
  const r = await apiFetch(path, { headers: headers(), signal })
  if (!r.ok) {
    redirectToLoginOnSession401(r.status)
    throw new ApiRequestError(r.statusText || `HTTP ${r.status}`, r.status, '', extractTraceId(null, r), parseRetryAfter(r))
  }
  return r.text()
}

export async function apiPost<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const r = await apiFetch(path, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify(body),
    signal,
  })
  return parseApiResponse<T>(r)
}

export async function apiPatch<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const r = await apiFetch(path, {
    method: 'PATCH',
    headers: jsonHeaders(),
    body: JSON.stringify(body),
    signal,
  })
  return parseApiResponse<T>(r)
}

export async function apiPut<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const r = await apiFetch(path, {
    method: 'PUT',
    headers: jsonHeaders(),
    body: JSON.stringify(body),
    signal,
  })
  return parseApiResponse<T>(r)
}

export async function apiDelete<T>(path: string, signal?: AbortSignal): Promise<T> {
  const r = await apiFetch(path, { method: 'DELETE', headers: headers(), signal })
  return parseApiResponse<T>(r)
}

/** Multipart upload (do not set Content-Type — browser sets boundary). */
export async function apiUpload<T>(path: string, file: File, fieldName = 'file', signal?: AbortSignal): Promise<T> {
  const fd = new FormData()
  fd.append(fieldName, file)
  const h: Record<string, string> = { Accept: 'application/json' }
  const tok = getToken().trim()
  if (tok) h.Authorization = `Bearer ${tok}`
  const r = await apiFetch(path, { method: 'POST', headers: h, body: fd, signal })
  return parseApiResponse<T>(r)
}
