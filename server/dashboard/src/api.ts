const TOKEN_KEY = 'neyra_api_token'

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? ''
}

export function setToken(t: string): void {
  const s = t.trim()
  if (s) localStorage.setItem(TOKEN_KEY, s)
  else localStorage.removeItem(TOKEN_KEY)
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

async function parseApiResponse<T>(r: Response): Promise<T> {
  const j = (await r.json()) as T & { ok?: boolean; error?: { message?: string } }
  if (!r.ok) {
    const msg = (j as { error?: { message?: string } }).error?.message ?? r.statusText
    throw new Error(msg || `HTTP ${r.status}`)
  }
  if (j && typeof j === 'object' && 'ok' in j && j.ok === false) {
    const msg = (j as { error?: { message?: string } }).error?.message ?? 'API error'
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
