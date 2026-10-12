import { describe, expect, it } from 'vitest'
import { collectHealthIssues, healthBlockReasons, healthTileState } from './health'

describe('healthTileState', () => {
  it('maps ok true/false/missing', () => {
    expect(healthTileState({ ok: true })).toBe('ok')
    expect(healthTileState({ ok: false })).toBe('warn')
    expect(healthTileState({})).toBe('unknown')
    expect(healthTileState(undefined)).toBe('unknown')
    expect(healthTileState('x')).toBe('unknown')
  })
})

describe('healthBlockReasons', () => {
  it('reads storage.missing and integrations.issues', () => {
    const health = {
      storage: { ok: false, missing: ['chroma'] },
      integrations: { ok: false, issues: ['discord down'] },
    }
    expect(healthBlockReasons(health, 'storage')).toEqual(['нет chroma'])
    expect(healthBlockReasons(health, 'integrations')).toEqual(['discord down'])
  })

  it('reads backend provider failures and plain error', () => {
    expect(
      healthBlockReasons(
        { backend: { ok: false, providers: [{ provider: 'or', ok: false, error: 'timeout' }] } },
        'backend',
      ),
    ).toEqual(['LLM or: timeout'])
    expect(healthBlockReasons({ backend: { ok: false, error: 'boom' } }, 'backend')).toEqual(['boom'])
    expect(healthBlockReasons({ backend: { ok: false } }, 'backend')).toEqual(['проверка не прошла'])
  })
})

describe('collectHealthIssues', () => {
  it('prefixes block reasons', () => {
    const issues = collectHealthIssues({
      storage: { ok: false, missing: ['db'] },
      self_healing: { ok: false },
    })
    expect(issues).toContain('Хранилище: нет db')
    expect(issues).toContain('Самолечение: ошибка')
  })
})
