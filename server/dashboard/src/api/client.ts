const TOKEN_KEY = 'neyra_api_token'
const SESSION_TOKEN_KEY = 'neyra_dashboard_session'

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
}

/** Clear dashboard session only — keep Settings API_TOKEN in localStorage. */
export function clearSessionToken(): void {
  sessionStorage.removeItem(SESSION_TOKEN_KEY)
}

/** Explicit API_TOKEN from Settings (localStorage). */
export function getStoredApiToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? ''
}

export function getToken(): string {
  // Prefer short-lived dashboard session (sessionStorage); else Settings API token.
  const session = sessionStorage.getItem(SESSION_TOKEN_KEY)?.trim()
  if (session) return session
  return localStorage.getItem(TOKEN_KEY) ?? ''
}

export function setToken(t: string): void {
  const s = t.trim()
  if (s) localStorage.setItem(TOKEN_KEY, s)
  else localStorage.removeItem(TOKEN_KEY)
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

async function parseApiResponse<T>(r: Response): Promise<T> {
  const text = await r.text()
  const trimmed = text.trimStart()
  if (trimmed.startsWith('<') || trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<!doctype')) {
    throw new Error(
      r.status >= 500 || r.status === 0
        ? `Сервер недоступен (HTTP ${r.status || '—'}). Подождите конца перезапуска или обновите страницу.`
        : `Ответ не JSON (HTTP ${r.status}) — сервер перезапускается или прокси вернул HTML.`,
    )
  }
  let j: T & { ok?: boolean; error?: { message?: string } }
  try {
    j = JSON.parse(text) as T & { ok?: boolean; error?: { message?: string } }
  } catch {
    throw new Error(`Не удалось разобрать ответ API (HTTP ${r.status})`)
  }
  if (!r.ok) {
    redirectToLoginOnSession401(r.status)
    const msg = j?.error?.message ?? r.statusText
    throw new Error(msg || `HTTP ${r.status}`)
  }
  if (j && typeof j === 'object' && 'ok' in j && j.ok === false) {
    const msg = j.error?.message ?? 'API error'
    throw new Error(msg)
  }
  return j as T
}

export async function apiGet<T>(path: string): Promise<T> {
  const r = await fetch(path, { headers: headers() })
  return parseApiResponse<T>(r)
}

export async function apiGetText(path: string): Promise<string> {
  const r = await fetch(path, { headers: headers() })
  if (!r.ok) {
    redirectToLoginOnSession401(r.status)
    throw new Error(r.statusText || `HTTP ${r.status}`)
  }
  return r.text()
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(path, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(body) })
  return parseApiResponse<T>(r)
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(path, { method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(body) })
  return parseApiResponse<T>(r)
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(path, { method: 'PUT', headers: jsonHeaders(), body: JSON.stringify(body) })
  return parseApiResponse<T>(r)
}

export async function apiDelete<T>(path: string): Promise<T> {
  const r = await fetch(path, { method: 'DELETE', headers: headers() })
  return parseApiResponse<T>(r)
}

/** Multipart upload (do not set Content-Type — browser sets boundary). */
export async function apiUpload<T>(path: string, file: File, fieldName = 'file'): Promise<T> {
  const fd = new FormData()
  fd.append(fieldName, file)
  const h: Record<string, string> = { Accept: 'application/json' }
  const tok = getToken().trim()
  if (tok) h.Authorization = `Bearer ${tok}`
  const r = await fetch(path, { method: 'POST', headers: h, body: fd })
  return parseApiResponse<T>(r)
}
