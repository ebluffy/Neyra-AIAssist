import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useState } from 'react'
import { Activity, Database, RefreshCw, RotateCcw, Wallet } from 'lucide-react'
import { ApiRequestError, apiGet, apiPost } from '../api'
import type { ApiEnvelope, BalanceData, HealthData, PluginRow, ProviderBalance } from '../api'
import { HealthHistoryStrip } from '../components/HealthHistoryStrip'
import { RestartProgress } from '../components/RestartProgress'
import { Button } from '../components/ui/button'
import { DangerConfirmDialog } from '../components/ui/danger-confirm-dialog'
import { EmptyState } from '../components/ui/empty-state'
import { ErrorState } from '../components/ui/error-state'
import { PageHeader } from '../components/ui/page-header'
import { Skeleton } from '../components/ui/skeleton'
import { waitForCoreRestart } from '../lib/wait-for-core-restart'
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
        <p className="page-sub" role="alert" style={{ color: 'var(--danger)' }}>
          {block._error}
          {block.detail ? `: ${block.detail}` : ''}
        </p>
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
  const qc = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const [restartMsg, setRestartMsg] = useState<string | null>(null)
  const [restartBusy, setRestartBusy] = useState(false)
  const [restartStep, setRestartStep] = useState<'stop' | 'offline' | 'online' | 'error'>('stop')
  const [restartConfirmOpen, setRestartConfirmOpen] = useState(false)
  const [tabVisible, setTabVisible] = useState(() => document.visibilityState === 'visible')

  useEffect(() => {
    const onVis = () => setTabVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  const pollOk = tabVisible && !restartBusy
  const healthQ = useQuery({
    queryKey: ['status', 'health'],
    queryFn: async () => (await apiGet<ApiEnvelope<HealthData>>('/v1/health')).data,
    refetchInterval: pollOk ? 15_000 : false,
  })
  const restQ = useQuery({
    queryKey: ['status', 'rest'],
    queryFn: async () => {
      const [b, p, m] = await Promise.all([
        apiGet<ApiEnvelope<BalanceData>>('/v1/llm/balance'),
        apiGet<ApiEnvelope<{ plugins: PluginRow[] }>>('/v1/plugins'),
        apiGet<ApiEnvelope<{ roles?: Record<string, { role?: string; provider?: string; model?: string }> }>>(
          '/v1/llm/models',
        ),
      ])
      return { balance: b.data, plugins: p.data.plugins ?? [], models: m.data }
    },
    refetchInterval: pollOk ? 60_000 : false,
  })
  const historyQ = useQuery({
    queryKey: ['status', 'health-history'],
    queryFn: async () =>
      (await apiGet<ApiEnvelope<{ hours: number; points: Array<Record<string, unknown>> }>>('/v1/health/history?hours=24'))
        .data,
    refetchInterval: pollOk ? 60_000 : false,
  })
  const auditQ = useQuery({
    queryKey: ['status', 'audit-recent'],
    queryFn: async (): Promise<{
      items: Array<{ ts?: string; op?: string; role?: string; trace_id?: string }>
      forbidden?: boolean
    }> => {
      try {
        return (
          await apiGet<ApiEnvelope<{ items: Array<{ ts?: string; op?: string; role?: string; trace_id?: string }> }>>(
            '/v1/audit/recent?limit=10',
          )
        ).data
      } catch (e) {
        if (e instanceof ApiRequestError && e.status === 403) {
          return { items: [], forbidden: true }
        }
        throw e
      }
    },
    refetchInterval: (q) => (pollOk && !q.state.data?.forbidden ? 60_000 : false),
    retry: false,
  })

  const health = healthQ.data ?? null
  const balance = restQ.data?.balance ?? null
  const plugins = restQ.data?.plugins ?? []
  const models = restQ.data?.models ?? null
  const loading = healthQ.isLoading || restQ.isLoading
  const load = useCallback(async () => {
    setError(null)
    await Promise.all([healthQ.refetch(), restQ.refetch(), historyQ.refetch(), auditQ.refetch()])
  }, [healthQ, restQ, historyQ, auditQ])

  async function softRestart() {
    setRestartConfirmOpen(false)
    setRestartBusy(true)
    setRestartMsg(null)
    setRestartStep('stop')
    setError(null)
    try {
      await apiPost<ApiEnvelope<{ note?: string }>>('/v1/system/restart', {})
      setRestartStep('offline')
      setRestartMsg('Процесс останавливается. Ждём offline → online…')
      const outcome = await waitForCoreRestart()
      if (outcome === 'online') {
        setRestartStep('online')
        setRestartMsg('Сервер снова онлайн.')
        await qc.invalidateQueries({ queryKey: ['status'] })
      } else if (outcome === 'no_downtime') {
        setRestartStep('error')
        setRestartMsg(
          'Рестарт не остановил процесс (API не уходил в offline). Проверь systemd/логи или systemctl restart neyra.',
        )
      } else {
        setRestartStep('error')
        setRestartMsg('Сервер долго не отвечает — обновите страницу вручную через минуту.')
      }
    } catch (e) {
      setRestartStep('error')
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
          <div className="row">
            <Button disabled={loading} onClick={() => void load()} type="button" variant="cyan">
              <RefreshCw aria-hidden size={15} style={loading ? { animation: 'spin 1s linear infinite' } : undefined} />
              {loading ? 'Обновление…' : 'Обновить'}
            </Button>
            <Button disabled={restartBusy} onClick={() => setRestartConfirmOpen(true)} type="button" variant="warn">
              <RotateCcw size={15} />
              Мягкий перезапуск
            </Button>
          </div>
        }
      />

      {!restartBusy && (error || healthQ.error || restQ.error) ? (
        <ErrorState
          error={error || healthQ.error || restQ.error || 'Ошибка загрузки'}
          onRetry={() => void load()}
        />
      ) : null}
      {restartBusy || restartMsg ? (
        <RestartProgress message={restartMsg ?? undefined} step={restartStep} />
      ) : null}

      <div className="card">
        <div className="card-header">
          <span className="card-title">Доступность за 24 ч</span>
        </div>
        {historyQ.error ? (
          <ErrorState error={historyQ.error} onRetry={() => void historyQ.refetch()} title="История health" />
        ) : (
          <HealthHistoryStrip
            loading={historyQ.isLoading}
            points={
              (historyQ.data?.points as Array<{
                timestamp?: string
                ok?: boolean
                backend_ok?: boolean
                storage_ok?: boolean
              }>) ?? []
            }
          />
        )}
      </div>

      <div className="grid-4">
        <div className="stat-tile">
          <p className="stat-label">Ядро</p>
          <p className="stat-value-md tabular-nums">{statusLabel(rawStatus)}</p>
          <p className="hint">{formatUptime(health?.uptime_seconds)}</p>
        </div>
        <div className="stat-tile">
          <p className="stat-label">Модули</p>
          <p className="stat-value-md tabular-nums">
            {plugins.filter((p) => p.enabled).length} / {plugins.length}
          </p>
          <p className="hint">включено / всего</p>
        </div>
        <div className="stat-tile">
          <p className="stat-label">Хранилище</p>
          <p className="stat-value-md tabular-nums">
            {fmtNum((health?.storage as Record<string, unknown> | undefined)?.ping_ms ?? (health?.storage as Record<string, unknown> | undefined)?.ok)}
          </p>
          <p className="hint">ping / ok</p>
        </div>
        <div className="stat-tile">
          <p className="stat-label">LLM</p>
          <p className="stat-value-md tabular-nums">{Object.keys(models?.roles ?? {}).length || '—'}</p>
          <p className="hint">ролей</p>
        </div>
      </div>

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
                <span className="hint shrink-0">Аптайм</span>
                <span className="mono">{formatUptime(health?.uptime_seconds)}</span>
              </div>
              <div className="kv-row">
                <span className="hint shrink-0">Версия API</span>
                <span className="mono">{fmtNum(version)}</span>
              </div>
              {health?.public_url != null && (
                <div className="kv-row">
                  <span className="hint shrink-0">Публичный URL</span>
                  <span className="mono text-break" style={{ fontSize: '0.75rem' }}>
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
          {loading && balance == null ? (
            <div className="stack-sm">
              <Skeleton className="h-16" />
              <Skeleton className="h-10" />
            </div>
          ) : (
            <>
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
                <EmptyState icon={Wallet} title="Нет данных баланса" description="Проверь провайдеров в настройках LLM." />
              )}
            </>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title">Модели (роли)</span>
        </div>
        <div className="grid-2">
          {loading && models == null && (
            <>
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
            </>
          )}
          {!loading && Object.entries(models?.roles ?? {}).length === 0 && (
            <EmptyState icon={Activity} title="Нет данных ролей" description="Ответ /v1/llm/models пуст или недоступен." />
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
          <span className="card-title">Последние действия</span>
        </div>
        {auditQ.isLoading ? (
          <Skeleton className="h-24" />
        ) : auditQ.error ? (
          <ErrorState
            error={auditQ.error}
            onRetry={() => void auditQ.refetch()}
            title="Аудит"
          />
        ) : auditQ.data?.forbidden ? (
          <p className="page-sub">Недоступно для роли.</p>
        ) : (auditQ.data?.items?.length ?? 0) === 0 ? (
          <p className="page-sub">Лента аудита пуста.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  {['Операция', 'Роль', 'Время', 'trace_id'].map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {auditQ.data!.items.map((row, i) => (
                  <tr key={`${row.trace_id ?? ''}-${i}`}>
                    <td className="mono">{row.op ?? '—'}</td>
                    <td>{row.role ?? '—'}</td>
                    <td className="tabular-nums">{row.ts ? String(row.ts).replace('T', ' ').slice(0, 19) : '—'}</td>
                    <td className="mono" style={{ fontSize: '0.75rem' }}>
                      {row.trace_id ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title">Модули (обзор)</span>
          <Link className="btn btn-secondary btn-sm" to="/modules">
            Открыть
          </Link>
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

      <DangerConfirmDialog
        busy={restartBusy}
        confirmLabel="Перезапустить"
        confirmPhrase="РЕСТАРТ"
        description="Мягкий перезапуск. Сессии дашборда сохранятся в SQLite, соединение оборвётся на несколько секунд."
        onCancel={() => setRestartConfirmOpen(false)}
        onConfirm={() => void softRestart()}
        open={restartConfirmOpen}
        title="Перезапустить Neyra?"
      />
    </div>
  )
}
