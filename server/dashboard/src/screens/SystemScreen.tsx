import { useCallback, useEffect, useState } from 'react'
import { Activity, DatabaseBackup, Info, Link2, Power, RefreshCw, ScrollText } from 'lucide-react'
import { Link } from 'react-router-dom'
import { apiGet, apiPost } from '../api'
import type { ApiEnvelope, BackupArchive, HealthData } from '../api'
import { LogViewer } from '../components/LogViewer'
import type { LogSource } from '../components/LogViewer'
import { Button } from '../components/ui/button'
import { EmptyState } from '../components/ui/empty-state'
import { InlineFeedback } from '../components/ui/inline-feedback'
import { PageHeader } from '../components/ui/page-header'
import { Skeleton } from '../components/ui/skeleton'
import { waitForCoreRestart } from '../lib/wait-for-core-restart'

type Tab = 'overview' | 'health' | 'logs' | 'backup'

const LOG_SOURCES: LogSource[] = [
  { id: 'system', label: 'Система' },
  { id: 'audit', label: 'Аудит API' },
  { id: 'chat', label: 'Чат' },
  { id: 'health', label: 'Health' },
]

const mono = { fontFamily: 'var(--mono)', fontSize: '0.78rem' } as const

function fmtBytes(n: number): string {
  if (!Number.isFinite(n)) return '—'
  if (n < 1024) return `${n} Б`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} КБ`
  return `${(n / 1024 / 1024).toFixed(1)} МБ`
}

function fmtTime(s?: string): string {
  if (!s) return '—'
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString('ru-RU')
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

function str(v: unknown): string {
  if (v == null || v === '') return '—'
  return String(v)
}

function collectHealthIssues(health: HealthData | null): string[] {
  if (!health) return []
  const issues: string[] = []
  const backend = health.backend as Record<string, unknown> | undefined
  if (backend && backend.ok === false) {
    const providers = backend.providers
    if (Array.isArray(providers)) {
      for (const p of providers) {
        if (!p || typeof p !== 'object') continue
        const row = p as Record<string, unknown>
        if (row.ok === false) {
          const prov = String(row.provider ?? '?')
          issues.push(row.error ? `LLM ${prov}: ${String(row.error)}` : `LLM ${prov}: HTTP ${String(row.status_code ?? '—')}`)
        }
      }
    }
    if (!issues.length) issues.push(backend.error ? `LLM-бэкенд: ${String(backend.error)}` : 'LLM-бэкенд: проверка не прошла')
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

function Kv({ label, value }: { label: string; value: string }) {
  return (
    <div className="kv-row">
      <span className="hint shrink-0">{label}</span>
      <span className="mono text-break" style={{ textAlign: 'right' }}>{value}</span>
    </div>
  )
}

export function SystemScreen() {
  const [tab, setTab] = useState<Tab>('overview')
  const [meta, setMeta] = useState<Record<string, unknown> | null>(null)
  const [health, setHealth] = useState<HealthData | null>(null)
  const [archives, setArchives] = useState<BackupArchive[]>([])
  const [lastRestoreApply, setLastRestoreApply] = useState<{
    status?: string
    archive_name?: string
    error?: string
    at?: string
  } | null>(null)
  const [dlqCount, setDlqCount] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [restartBusy, setRestartBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [healthLoading, setHealthLoading] = useState(false)
  const [backupLoading, setBackupLoading] = useState(false)
  const [showRaw, setShowRaw] = useState(false)

  const loadHealth = useCallback(async () => {
    setHealthLoading(true)
    try {
      const h = await apiGet<ApiEnvelope<HealthData>>('/v1/health')
      setHealth(h.data)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setHealthLoading(false)
    }
  }, [])

  const loadBackups = useCallback(async () => {
    setBackupLoading(true)
    try {
      const r = await apiGet<
        ApiEnvelope<{
          archives?: BackupArchive[]
          last_restore_apply?: {
            status?: string
            archive_name?: string
            error?: string
            at?: string
          } | null
        }>
      >('/v1/backup/list')
      setArchives(r.data.archives ?? [])
      setLastRestoreApply(r.data.last_restore_apply ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBackupLoading(false)
    }
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [m, d] = await Promise.all([
        apiGet<ApiEnvelope<Record<string, unknown>>>('/v1/meta'),
        apiGet<ApiEnvelope<{ items?: unknown[]; deliveries?: unknown[] } | unknown[]>>('/v1/webhooks/dlq'),
      ])
      setMeta(m.data)
      const raw = d.data
      const list = Array.isArray(raw)
        ? raw
        : (raw as { items?: unknown[]; deliveries?: unknown[] }).items
          ?? (raw as { deliveries?: unknown[] }).deliveries
          ?? []
      setDlqCount(list.length)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (tab === 'health' && !health) void loadHealth()
    if (tab === 'backup' && archives.length === 0) void loadBackups()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  async function waitAfterRestart(prefix: string) {
    setRestartBusy(true)
    try {
      const outcome = await waitForCoreRestart()
      if (outcome === 'online') {
        setStatus(`${prefix} Сервер снова онлайн.`)
        await load()
        if (tab === 'health') await loadHealth()
        if (tab === 'backup') await loadBackups()
      } else if (outcome === 'no_downtime') {
        setStatus('')
        setError('Рестарт не остановил процесс (API не уходил в offline). Проверь systemd/логи или systemctl restart neyra.')
      } else {
        setStatus(`${prefix} Сервер долго не отвечает — обнови страницу через минуту.`)
      }
    } finally {
      setRestartBusy(false)
    }
  }

  async function softRestart() {
    if (
      !window.confirm(
        'Мягкий рестарт всего процесса Neyra? Resident-модули (Discord) и Lavalink поднимутся заново. Дашборд на несколько секунд отвалится.',
      )
    ) {
      return
    }
    setError(null)
    setStatus('Мягкий рестарт… ждём подъёма API')
    setRestartBusy(true)
    try {
      await apiPost<ApiEnvelope<{ note?: string }>>('/v1/system/restart', {})
      await waitAfterRestart('Мягкий рестарт.')
    } catch (e) {
      setStatus('')
      setError(e instanceof Error ? e.message : String(e))
      setRestartBusy(false)
    }
  }

  async function runBackup() {
    if (!window.confirm('Запустить бэкап сейчас?')) return
    setBusy(true)
    setStatus('')
    setError(null)
    try {
      await apiPost<ApiEnvelope<unknown>>('/v1/backup/run', {})
      setStatus('Бэкап создан.')
      await loadBackups()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function restoreBackup(name: string) {
    if (
      !window.confirm(
        `ВОССТАНОВИТЬ из «${name}»?\n\nПеред заменой будет создан страховочный бэкап текущего состояния (pre_restore). Подмена памяти применится при перезапуске ядра.`,
      )
    ) {
      return
    }
    if (window.prompt(`Для подтверждения введи имя архива:\n${name}`) !== name) {
      setStatus('Восстановление отменено: имя архива не совпало.')
      return
    }
    setBusy(true)
    setStatus('Готовлю восстановление…')
    setError(null)
    try {
      const r = await apiPost<
        ApiEnvelope<{
          restart_scheduled?: boolean
          pre_restore_backup?: string
          pre_restore_backup_name?: string
          pending?: boolean
          created_at?: string
          archive_name?: string
        }>
      >('/v1/backup/restore', {
        archive_name: name,
        confirm: 'RESTORE',
      })
      const safety =
        r.data.pre_restore_backup_name ||
        (r.data.pre_restore_backup ? r.data.pre_restore_backup.split(/[/\\]/).pop() : '') ||
        ''
      const safetyNote = safety ? ` Страховочный архив: ${safety}.` : ''
      const expectCreated = (r.data.created_at || '').trim()
      const expectArchive = (r.data.archive_name || name).trim()
      if (r.data.restart_scheduled) {
        setStatus(`Восстановление подготовлено.${safetyNote} Ядро перезапускается…`)
        setBusy(false)
        await waitAfterRestart(`Ожидаю результат restore при старте.${safetyNote}`)
        try {
          const lr = await apiGet<
            ApiEnvelope<{
              last_restore_apply?: {
                status?: string
                archive_name?: string
                error?: string
                created_at?: string
                at?: string
              } | null
            }>
          >('/v1/backup/list')
          const result = lr.data.last_restore_apply
          setLastRestoreApply(result ?? null)
          const matches =
            !!result &&
            (result.archive_name || '') === expectArchive &&
            (!expectCreated || (result.created_at || '') === expectCreated) &&
            (!expectCreated || !result.at || result.at >= expectCreated)
          if (matches && result?.status === 'applied') {
            setStatus(`Восстановление применено (${expectArchive}).${safetyNote}`)
          } else if (matches && (result?.status === 'failed' || result?.status === 'rollback_failed')) {
            setStatus('')
            setError(
              `Восстановление при старте не применилось${result.error ? `: ${result.error}` : ''}.${safetyNote}`,
            )
          } else {
            setStatus(
              `Рестарт выполнен.${safetyNote} Результат этого restore неизвестен (нет свежего last_restore_apply).`,
            )
          }
        } catch {
          setStatus(`Рестарт выполнен.${safetyNote} Результат apply не прочитан.`)
        }
        await loadBackups()
        return
      }
      setStatus(`Восстановление подготовлено.${safetyNote} Нужен мягкий рестарт.`)
    } catch (e) {
      setStatus('')
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const tabs: [Tab, string, typeof Info][] = [
    ['overview', 'Обзор', Info],
    ['health', 'Здоровье', Activity],
    ['logs', 'Логи', ScrollText],
    ['backup', 'Бэкап', DatabaseBackup],
  ]

  const features =
    meta && typeof meta.features === 'object' && meta.features
      ? Object.entries(meta.features as Record<string, unknown>)
      : []

  const rawStatus = String(
    (health?.status as string | undefined) ?? (health?.ok === true ? 'ok' : health?.ok === false ? 'degraded' : 'unknown'),
  ).toLowerCase()
  const isOk = ['ok', 'online', 'healthy'].includes(rawStatus)
  const isUnknown = rawStatus === 'unknown'
  const healthIssues = collectHealthIssues(health)
  const healthVersion = (health?.version as string | undefined) ?? (health?.api_version as string | undefined)

  return (
    <div className="page-content stack">
      <PageHeader
        title="Система"
        subtitle="Сведения о API, здоровье, логи и бэкап"
        actions={
          <Button
            disabled={loading}
            onClick={() => {
              void load()
              if (tab === 'health') void loadHealth()
              if (tab === 'backup') void loadBackups()
            }}
            type="button"
            variant="secondary"
          >
            <RefreshCw aria-hidden size={14} style={loading ? { animation: 'spin 1s linear infinite' } : undefined} />
            {loading ? 'Обновление…' : 'Обновить'}
          </Button>
        }
      />
      {error && <InlineFeedback tone="error">{error}</InlineFeedback>}
      {status && <InlineFeedback tone="success">{status}</InlineFeedback>}

      <div className="card">
        <div className="panel-tabs panel-tabs-dense" role="tablist">
          {tabs.map(([id, label, Icon]) => (
            <button
              key={id}
              aria-selected={tab === id}
              className={`panel-tab${tab === id ? ' active' : ''}`}
              onClick={() => setTab(id)}
              role="tab"
              type="button"
            >
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>

        {tab === 'overview' && (
          <div className="stack">
            <div>
              <div className="section-title">Сведения API</div>
              {loading && !meta ? (
                <div className="stack-sm">
                  <Skeleton className="h-10" />
                  <Skeleton className="h-24" />
                </div>
              ) : meta ? (
                <div className="grid-2">
                  <div className="stat-tile">
                    <p className="stat-label">Версия API</p>
                    <p className="stat-value-md">{str(meta.api_version)}</p>
                  </div>
                  <div className="stat-tile">
                    <p className="stat-label">Публичный URL</p>
                    <p className="stat-value-md" style={{ ...mono, wordBreak: 'break-all' }}>{str(meta.public_url)}</p>
                  </div>
                  <div className="stat-tile">
                    <p className="stat-label">Публичный /v1</p>
                    <p className="stat-value-md" style={{ ...mono, wordBreak: 'break-all' }}>{str(meta.public_v1)}</p>
                  </div>
                  <div className="stat-tile">
                    <p className="stat-label">Дашборд</p>
                    <p className="stat-value-md" style={{ ...mono, wordBreak: 'break-all' }}>{str(meta.dashboard_url)}</p>
                  </div>
                </div>
              ) : (
                <EmptyState icon={Info} title="Нет данных" description="Не удалось получить /v1/meta." />
              )}
            </div>

            {features.length > 0 && (
              <div>
                <div className="section-title">Возможности</div>
                <div className="row">
                  {features.map(([k, v]) => (
                    <span
                      key={k}
                      className={`status-badge ${v ? 'status-ok' : 'status-idle'}`}
                      style={{ padding: '0.15rem 0.55rem', fontSize: '0.72rem' }}
                    >
                      {k}: {v ? 'да' : 'нет'}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {meta && (
              <div>
                <Button onClick={() => setShowRaw((v) => !v)} size="sm" type="button" variant="secondary">
                  {showRaw ? 'Скрыть JSON' : 'Показать JSON'}
                </Button>
                {showRaw && (
                  <pre className="code-block" style={{ maxHeight: 320, marginTop: '0.5rem' }}>
                    {JSON.stringify(meta, null, 2)}
                  </pre>
                )}
              </div>
            )}

            <hr className="divider" style={{ margin: 0 }} />
            <div className="row-between">
              <div className="row">
                <Link2 aria-hidden size={15} className="card-icon card-icon-pink" />
                <span className="hint">
                  Очередь ошибок вебхуков:{' '}
                  <strong className="mono" style={{ color: 'var(--text)' }}>
                    {loading && dlqCount == null ? '…' : (dlqCount ?? '—')}
                  </strong>
                </span>
              </div>
              <Link className="btn btn-secondary btn-sm" to="/webhooks">
                Открыть вебхуки
              </Link>
            </div>

            <hr className="divider" style={{ margin: 0 }} />
            <div className="row-between">
              <span className="hint">Мягкий рестарт перезапускает процесс ядра; дашборд на несколько секунд отвалится.</span>
              <Button disabled={restartBusy} onClick={() => void softRestart()} type="button" variant="warn">
                <Power aria-hidden size={14} /> {restartBusy ? 'Рестарт…' : 'Мягкий рестарт'}
              </Button>
            </div>
          </div>
        )}

        {tab === 'health' && (
          <div className="stack">
            {healthLoading && !health ? (
              <div className="stack-sm">
                <Skeleton className="h-8" />
                <Skeleton className="h-16" />
              </div>
            ) : health ? (
              <>
                <span
                  className={`status-badge ${isOk ? 'status-ok' : isUnknown ? 'status-idle' : 'status-warn'}`}
                  style={{ alignSelf: 'flex-start' }}
                >
                  <span className={`status-dot ${isOk ? 'status-dot-ok' : isUnknown ? 'status-dot-idle' : 'status-dot-warn'}`} />
                  {isOk ? 'ок' : isUnknown ? 'неизвестно' : 'есть проблемы'}
                </span>
                {healthIssues.length > 0 ? (
                  <ul style={{ margin: 0, paddingLeft: '1.1rem', fontSize: '0.8rem', color: 'var(--amber)', lineHeight: 1.5 }}>
                    {healthIssues.map((msg) => (
                      <li key={msg}>{msg}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="hint">Проблем не найдено.</p>
                )}
                <div className="stack-sm">
                  <Kv label="Аптайм" value={formatUptime(health.uptime_seconds)} />
                  <Kv label="Версия API" value={str(healthVersion)} />
                  {health.public_url != null && <Kv label="Публичный URL" value={str(health.public_url)} />}
                </div>
                <div>
                  <Link className="btn btn-secondary btn-sm" to="/status">
                    Баланс LLM и модели
                  </Link>
                </div>
              </>
            ) : (
              <EmptyState icon={Activity} title="Нет данных" description="Не удалось получить /v1/health." />
            )}
            <div>
              <Button disabled={healthLoading} onClick={() => void loadHealth()} size="sm" type="button" variant="secondary">
                {healthLoading ? 'Проверяю…' : 'Проверить снова'}
              </Button>
            </div>
          </div>
        )}

        {tab === 'logs' && <LogViewer sources={LOG_SOURCES} />}

        {tab === 'backup' && (
          <div className="stack">
            <div className="row-between">
              <p className="hint">Локальные архивы бэкапа (роль maint и выше).</p>
              <div className="row">
                <Button disabled={backupLoading} onClick={() => void loadBackups()} size="sm" type="button" variant="secondary">
                  {backupLoading ? 'Загрузка…' : 'Обновить список'}
                </Button>
                <Button disabled={busy || restartBusy} onClick={() => void runBackup()} type="button">
                  <DatabaseBackup size={14} /> {busy ? 'Работаю…' : 'Создать бэкап'}
                </Button>
              </div>
            </div>
            {lastRestoreApply?.status ? (
              <p className="hint" style={{ margin: 0 }}>
                Последний restore при старте:{' '}
                <strong>
                  {lastRestoreApply.status === 'applied'
                    ? 'применён'
                    : lastRestoreApply.status === 'rollback_failed'
                      ? 'откат не удался'
                      : lastRestoreApply.status === 'failed'
                        ? 'не применён'
                        : lastRestoreApply.status}
                </strong>
                {lastRestoreApply.archive_name ? ` · ${lastRestoreApply.archive_name}` : ''}
                {lastRestoreApply.error ? ` · ${lastRestoreApply.error}` : ''}
                {lastRestoreApply.at ? ` · ${lastRestoreApply.at}` : ''}
              </p>
            ) : null}
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    {['Архив', 'Размер', 'Изменён', ''].map((h) => (
                      <th key={h}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {archives.length === 0 ? (
                    <tr>
                      <td colSpan={4}>
                        <EmptyState
                          icon={DatabaseBackup}
                          title={backupLoading ? 'Загрузка…' : 'Архивов нет'}
                          description={backupLoading ? '' : 'Нажми «Создать бэкап».'}
                        />
                      </td>
                    </tr>
                  ) : (
                    archives.map((a) => (
                      <tr key={a.name}>
                        <td style={{ ...mono, wordBreak: 'break-all' }}>{a.name}</td>
                        <td style={{ ...mono, whiteSpace: 'nowrap' }}>{fmtBytes(a.bytes)}</td>
                        <td style={{ ...mono, whiteSpace: 'nowrap' }}>{fmtTime(a.mtime)}</td>
                        <td>
                          <Button
                            disabled={busy || restartBusy}
                            onClick={() => void restoreBackup(a.name)}
                            size="sm"
                            type="button"
                            variant="danger"
                          >
                            Восстановить
                          </Button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
