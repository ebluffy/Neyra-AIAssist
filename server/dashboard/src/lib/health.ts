import type { HealthData } from '../api'

export type HealthBlockKey = 'backend' | 'storage' | 'integrations' | 'self_healing'

export function healthBlockReasons(health: HealthData | null, key: HealthBlockKey): string[] {
  if (!health) return []
  const block = health[key] as Record<string, unknown> | undefined
  if (!block || typeof block !== 'object') return []
  if (block.ok !== false) return []
  if (key === 'backend') {
    const out: string[] = []
    const providers = block.providers
    if (Array.isArray(providers)) {
      for (const p of providers) {
        if (!p || typeof p !== 'object') continue
        const row = p as Record<string, unknown>
        if (row.ok === false) {
          const prov = String(row.provider ?? '?')
          out.push(row.error ? `LLM ${prov}: ${String(row.error)}` : `LLM ${prov}: HTTP ${String(row.status_code ?? '—')}`)
        }
      }
    }
    if (!out.length && block.error) out.push(String(block.error))
    if (!out.length) out.push('проверка не прошла')
    return out
  }
  if (key === 'storage') {
    const missing = Array.isArray(block.missing) ? block.missing.map(String) : []
    if (missing.length) return [`нет ${missing.join(', ')}`]
    if (block.error) return [String(block.error)]
    return ['ошибка']
  }
  if (key === 'integrations') {
    const list = Array.isArray(block.issues) ? block.issues.map(String) : []
    if (list.length) return list
    if (block.error) return [String(block.error)]
    return ['ошибка']
  }
  if (block.error) return [String(block.error)]
  return ['ошибка']
}

export function collectHealthIssues(health: HealthData | null): string[] {
  if (!health) return []
  const issues: string[] = []
  for (const msg of healthBlockReasons(health, 'backend')) {
    issues.push(msg.startsWith('LLM ') ? msg : `LLM-бэкенд: ${msg}`)
  }
  for (const msg of healthBlockReasons(health, 'storage')) issues.push(`Хранилище: ${msg}`)
  for (const msg of healthBlockReasons(health, 'integrations')) issues.push(`Интеграции: ${msg}`)
  for (const msg of healthBlockReasons(health, 'self_healing')) issues.push(`Самолечение: ${msg}`)
  return issues
}

export function healthTileState(block: unknown): 'ok' | 'warn' | 'unknown' {
  if (!block || typeof block !== 'object') return 'unknown'
  const ok = (block as Record<string, unknown>).ok
  if (ok === true) return 'ok'
  if (ok === false) return 'warn'
  return 'unknown'
}
