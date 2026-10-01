import { useCallback, useEffect, useState } from 'react'
import { Activity, Database, RefreshCw, RotateCcw, Wallet } from 'lucide-react'
import { apiGet, apiPost } from '../api'
import type { ApiEnvelope, BalanceData, HealthData, PluginRow, ProviderBalance } from '../api'
import { Button } from '../components/ui/button'
import { EmptyState } from '../components/ui/empty-state'
import { InlineFeedback } from '../components/ui/inline-feedback'
import { PageHeader } from '../components/ui/page-header'
import { Skeleton } from '../components/ui/skeleton'
import { Link } from 'react-router-dom'

function fmtNum(v: unknown): string {
  if (v == null || v === '') return '—'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '—'
  return String(v)
}

function fmtBalanceValue(v: unknown, emptyHint?: string): string {
  if (v == null || v === '') return emptyHint ?? '—'
  return fmtNum(v)
}

function statusLabel(raw: string): string {
  const s = raw.toLowerCase()
  if (s === 'ok' || s === 'online' || s === 'healthy') return 'ок'
  if (s === 'degraded' || s === 'warn' || s === 'warning') return 'есть проблемы'
  if (s === 'unknown') return 'неизвестно'
  return raw
}

function collectHealthIssues(health: HealthData | null): string[] {
  if (!health) return []
  const issues: string[] = []
  const backend = health.backend as Record<string, unknown> | undefined
  if (backend && backend.ok === false) {
    const err = backend.error != null ? String(backend.error) : ''
    const providers = backend.providers
    if (Array.isArray(providers) && providers.length) {
      for (const p of providers) {
        if (!p || typeof p !== 'object') continue
        const row = p as Record<string, unknown>
        if (row.ok === false) {
          const prov = String(row.provider ?? '?')
          if (row.error) issues.push(`LLM ${prov}: ${String(row.error)}`)
          else issues.push(`LLM ${prov}: HTTP ${String(row.status_code ?? '—')}`)
        }
      }
    }
    if (!issues.some((x) => x.startsWith('LLM ')) && err) issues.push(`LLM-бэкенд: ${err}`)
    else if (!issues.length) issues.push('LLM-бэкенд: проверка не прошла')
  }
  const storage = health.storage as Record<string, unknown> | undefined
  if (storage && storage.ok === false) {
    const missing = Array.isArray(storage.missing) ? storage.missing.map(String) : []
    issues.push(missing.length ? `Хранилище: нет ${missing.join(', ')}` : 'Хранилище: ошибка')
  }
  const integrations = health.integrations as Record<string, unknown> | undefined
  if (integrations && integrations.ok === false) {
    const list = Array.isArray(integrations.issues) ? integrations.issues.map(String) : []
    issues.push(list.length ? `Интеграции: ${list.join('; ')}` : 'Интеграции: ошибка')
  }
  const heal = health.self_healing as Record<string, unknown> | undefined
  if (heal && heal.ok === false) issues.push('Самолечение модулей: ошибка')
  return issues
}

function formatUptime(sec: unknown): string {
  const n = typeof sec === 'number' ? sec : Number(sec)
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 60) return `${Math.floor(n)} с`
  if (n < 3600) return `${Math.floor(n / 60)} мин`
  const h = Math.floor(n / 3600)
  const m = Math.floor((n % 3600) / 60)
  return `${h} ч ${m} мин`
}

function ProviderBalanceBlock({ name, block }: { name: string; block: ProviderBalance }) {
  return (
    <div className="stack-sm" style={{ marginBottom: '0.75rem' }}>
      <p style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text)' }}>{name}</p>
      {block._error ? (
        <InlineFeedback tone="error">{block._error}{block.detail ? `: ${block.detail}` : ''}</InlineFeedback>
      ) : (
        <>
          <div className="grid-4">
            {[
              { label: 'Остаток', value: fmtBalanceValue(block.limit_remaining, block.limit == null ? 'без лимита' : '—') },
              { label: 'Лимит', value: fmtBalanceValue(block.limit, 'без лимита') },
              { label: 'Израсходовано', value: fmtBalanceValue(block.usage) },
              { label: 'Метка', value: fmtBalanceValue(block.label) },
            ].map(({ label, value }) => (
              <div key={label} className="stat-tile">
                <p className="stat-label">{label}</p>
                <p className="stat-value-md">{value}</p>
              </div>
            ))}
          </div>
          <p style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>
            День / неделя / месяц:{' '}
            <span style={{ fontFamily: 'var(--mono)', color: 'var(--text)' }}>
              {fmtBalanceValue(block.usage_daily)} / {fmtBalanceValue(block.usage_weekly)} / {fmtBalanceValue(block.usage_monthly)}
            </span>
          </p>
        </>
      )}
    </div>
  )
}

export function StatusScreen() {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [health, setHealth] = useState<HealthData | null>(null)
  const [balance, setBalance] = useState<BalanceData | null>(null)
  const [plugins, setPlugins] = useState<PluginRow[]>([])
  const [models, setModels] = useState<{ roles?: Record<string, { role?: string; provider?: string; model?: string }> } | null>(null)
  const [restartMsg, setRestartMsg] = useState<string | null>(null)
  const [restartBusy, setRestartBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [h, b, p, m] = await Promise.all([
        apiGet<ApiEnvelope<HealthData>>('/v1/health'),
        apiGet<ApiEnvelope<BalanceData>>('/v1/llm/balance'),
        apiGet<ApiEnvelope<{ plugins: PluginRow[] }>>('/v1/plugins'),
        apiGet<ApiEnvelope<{ roles?: Record<string, { role?: string; provider?: string; model?: string }> }>>('/v1/llm/models'),
      ])
      setHealth(h.data)
      setBalance(b.data)
      setPlugins(p.data.plugins ?? [])
      setModels(m.data)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function softRestart() {
    if (!window.confirm('Перезапустить процесс Neyra (soft restart)? Сессии дашборда сохранятся в SQLite, но соединение оборвётся на несколько секунд.')) {
      return
    }
    setRestartBusy(true)
    setRestartMsg(null)
    try {
      const r = await apiPost<ApiEnvelope<{ note?: string }>>('/v1/system/restart', {})
      setRestartMsg(r.data?.note ?? 'Рестарт запланирован')
    } catch (e) {
      setRestartMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setRestartBusy(false)
    }
  }

  const rawStatus = String(
    (health?.status as string | undefined)
      ?? (health?.ok === true ? 'ok' : health?.ok === false ? 'degraded' : 'unknown'),
  ).toLowerCase()
  const isOk = rawStatus === 'ok' || rawStatus === 'online' || rawStatus === 'healthy'
  const isUnknown = rawStatus === 'unknown'
  const statusClass = isOk ? 'status-ok' : isUnknown ? 'status-idle' : 'status-warn'
  const dotClass = isOk ? 'status-dot-ok' : isUnknown ? 'status-dot-idle' : 'status-dot-warn'
  const version = (health?.version as string | undefined) ?? (health?.api_version as string | undefined)
  const healthIssues = collectHealthIssues(health)
  const roleLabels: Record<string, string> = { talk: 'речь', brain: 'мозг', memory: 'память', vision: 'зрение' }

  return (
    <div className="page-content stack">
      <PageHeader
        title="Статус"
        subtitle="Состояние ядра, модели и баланс LLM"
        actions={
          <div className="row" style={{ gap: 8 }}>
            <Button disabled={loading} onClick={() => void load()} type="button" variant="cyan">
              <RefreshCw size={15} style={loading ? { animation: 'spin 1s linear infinite' } : undefined} />
              {loading ? 'Обновление…' : 'Обновить'}
            </Button>
            <Button disabled={restartBusy} onClick={() => void softRestart()} type="button" variant="warn">
              <RotateCcw size={15} />
              Soft restart
            </Button>
          </div>
        }
      />

      {error && <InlineFeedback tone="error">{error}</InlineFeedback>}
      {restartMsg && <InlineFeedback tone="success">{restartMsg}</InlineFeedback>}

      <div className="split-status">
        <div className="card">
          <div className="card-header">
            <Activity size={15} className="card-icon" />
            <span className="card-title">Состояние</span>
          </div>
          {loading ? (
            <div className="stack-sm">
              <Skeleton className="h-8" />
              <Skeleton className="h-6" />
            </div>
          ) : (
            <div className="stack-sm">
              <span className={`status-badge ${statusClass}`} style={{ alignSelf: 'flex-start' }}>
                <span className={`status-dot ${dotClass}`} />
                {statusLabel(rawStatus)}
              </span>
              {healthIssues.length > 0 && (
                <ul style={{ margin: 0, paddingLeft: '1.1rem', fontSize: '0.78rem', color: 'var(--amber)', lineHeight: 1.45 }}>
                  {healthIssues.map((msg) => (
                    <li key={msg}>{msg}</li>
                  ))}
                </ul>
              )}
              <div className="kv-row">
                <span style={{ color: 'var(--muted)' }}>Аптайм</span>
                <span style={{ fontFamily: 'var(--mono)' }}>{formatUptime(health?.uptime_seconds)}</span>
              </div>
              <div className="kv-row">
                <span style={{ color: 'var(--muted)' }}>Версия API</span>
                <span style={{ fontFamily: 'var(--mono)' }}>{fmtNum(version)}</span>
              </div>
              {health?.public_url != null && (
                <div className="kv-row">
                  <span style={{ color: 'var(--muted)' }}>Public URL</span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: '0.75rem', wordBreak: 'break-all' }}>
                    {String(health.public_url)}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-header">
            <Wallet size={15} className="card-icon card-icon-pink" />
            <span className="card-title">Баланс LLM</span>
          </div>
          {balance?.roles && (
            <p style={{ fontSize: '0.82rem', color: 'var(--muted)', marginBottom: '0.75rem' }}>
              Роли:{' '}
              <span style={{ fontFamily: 'var(--mono)', color: 'var(--text)' }}>
                {Object.entries(balance.roles)
                  .map(([k, v]) => `${roleLabels[k] ?? k}=${v}`)
                  .join(' · ') || '—'}
              </span>
            </p>
          )}
          {(
            [
              ['OpenRouter', balance?.openrouter],
              ['AIHope', balance?.aihope],
            ] as const
          )
            .filter(([, block]) => block != null)
            .map(([name, block]) => (
              <ProviderBalanceBlock key={name} block={block as ProviderBalance} name={name} />
            ))}
          {!balance?.openrouter && !balance?.aihope && (
            <p style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>Нет данных баланса</p>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title">Модели (роли)</span>
        </div>
        <div className="grid-2">
          {Object.entries(models?.roles ?? {}).length === 0 && !loading && (
            <p style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>Нет данных ролей</p>
          )}
          {Object.entries(models?.roles ?? {}).map(([short, row]) => (
            <div key={short} className="stat-tile model-role-card">
              <p className="stat-label">{roleLabels[short] ?? short}</p>
              <p className="stat-value-md" style={{ fontFamily: 'var(--mono)', fontSize: '0.9rem' }}>
                {row.model ?? '—'}
              </p>
              <p style={{ fontSize: '0.75rem', color: 'var(--muted)', marginTop: 6 }}>
                провайдер <span style={{ fontFamily: 'var(--mono)', color: 'var(--text)' }}>{row.provider ?? '—'}</span>
                <span style={{ color: 'var(--border-hi)' }}> · </span>
                <span style={{ fontFamily: 'var(--mono)' }}>{row.role ?? short}</span>
              </p>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title">Модули (обзор)</span>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                {['ID', 'Версия', 'Жизненный цикл', 'Статус'].map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {plugins.length === 0 ? (
                <tr>
                  <td colSpan={4}>
                    <EmptyState
                      icon={Database}
                      title="Нет модулей"
                      description="Открой раздел Модули или проверь /v1/plugins"
                      action={
                        <Link className="btn btn-secondary btn-sm" to="/modules">
                          Модули
                        </Link>
                      }
                    />
                  </td>
                </tr>
              ) : (
                plugins.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <span style={{ fontFamily: 'var(--mono)', fontSize: '0.8rem' }}>{row.id}</span>
                    </td>
                    <td>{row.version}</td>
                    <td>{row.lifecycle}</td>
                    <td>
                      <span className={`status-badge ${row.enabled ? 'status-ok' : 'status-idle'}`} style={{ padding: '0.2rem 0.6rem', fontSize: '0.75rem' }}>
                        <span className={`status-dot ${row.enabled ? 'status-dot-ok' : 'status-dot-idle'}`} />
                        {row.enabled ? 'вкл.' : 'выкл.'}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
