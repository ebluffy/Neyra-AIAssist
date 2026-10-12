/** Public rotate (no session Bearer) — avoids 401 session redirect on wrong key. */
export async function rotateAccessKey(currentKey: string, newKey: string): Promise<string> {
  const ctrl = new AbortController()
  const timer = window.setTimeout(() => ctrl.abort(), 30_000)
  let r: Response
  try {
    r = await fetch('/v1/dashboard/auth/rotate', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_key: currentKey, new_key: newKey }),
      signal: ctrl.signal,
    })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new Error('Таймаут запроса смены ключа')
    }
    throw e
  } finally {
    window.clearTimeout(timer)
  }
  const text = await r.text()
  const trimmed = text.trimStart()
  if (trimmed.startsWith('<') || trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<!doctype')) {
    throw new Error(`Сервер недоступен (HTTP ${r.status || '—'}). Попробуй позже.`)
  }
  let j: { ok?: boolean; data?: { session_token?: string }; error?: { message?: string } }
  try {
    j = JSON.parse(text) as typeof j
  } catch {
    throw new Error(`Не удалось разобрать ответ API (HTTP ${r.status})`)
  }
  if (!r.ok || j.ok === false) {
    throw new Error(j.error?.message || `HTTP ${r.status}`)
  }
  const session = j.data?.session_token?.trim()
  if (!session) throw new Error('Сервер не выдал session_token')
  return session
}
