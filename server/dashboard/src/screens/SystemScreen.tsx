import { useCallback, useEffect, useState } from 'react'
import { DatabaseBackup, Info, Link2, ScrollText } from 'lucide-react'
import { Link } from 'react-router-dom'
import { apiGet, apiPost } from '../api'
import type { ApiEnvelope } from '../api'
import { LogViewer } from '../components/LogViewer'
import type { LogSource } from '../components/LogViewer'
import { Button } from '../components/ui/button'
import { InlineFeedback } from '../components/ui/inline-feedback'
import { PageHeader } from '../components/ui/page-header'
import { Skeleton } from '../components/ui/skeleton'

type Tab = 'overview' | 'logs' | 'backup'

const LOG_SOURCES: LogSource[] = [
  { id: 'system', label: 'Система' },
  { id: 'audit', label: 'Аудит API' },
  { id: 'chat', label: 'Чат' },
  { id: 'health', label: 'Health' },
]

export function SystemScreen() {
  const [tab, setTab] = useState<Tab>('overview')
  const [meta, setMeta] = useState<Record<string, unknown> | null>(null)
  const [dlqCount, setDlqCount] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)

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

  async function runBackup() {
    if (!window.confirm('Запустить бэкап сейчас?')) return
    setBusy(true)
    setStatus('')
    setError(null)
    try {
      const r = await apiPost<ApiEnvelope<unknown>>('/v1/backup/run', {})
      setStatus(JSON.stringify(r.data, null, 2))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const tabs: [Tab, string, typeof Info][] = [
    ['overview', 'Обзор', Info],
    ['logs', 'Логи', ScrollText],
    ['backup', 'Бэкап', DatabaseBackup],
  ]

  return (
    <div className="page-content stack">
      <PageHeader
        title="Система"
        subtitle="Сведения о API, логи и бэкап"
        actions={
          <Button disabled={loading} onClick={() => void load()} type="button" variant="secondary">
            {loading ? 'Обновление…' : 'Обновить'}
          </Button>
        }
      />
      {error && <InlineFeedback tone="error">{error}</InlineFeedback>}

      <div className="card">
        <div className="panel-tabs" role="tablist">
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
              ) : (
                <pre className="code-block" style={{ maxHeight: 360 }}>
                  {meta ? JSON.stringify(meta, null, 2) : '—'}
                </pre>
              )}
            </div>
            <hr className="divider" style={{ margin: 0 }} />
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div className="row">
                <Link2 size={15} className="card-icon card-icon-pink" />
                <span style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>
                  Очередь ошибок вебхуков:{' '}
                  <strong style={{ color: 'var(--text)', fontFamily: 'var(--mono)' }}>
                    {loading && dlqCount == null ? '…' : (dlqCount ?? '—')}
                  </strong>
                </span>
              </div>
              <Link className="btn btn-secondary btn-sm" to="/webhooks">
                Открыть вебхуки
              </Link>
            </div>
          </div>
        )}

        {tab === 'logs' && <LogViewer sources={LOG_SOURCES} />}

        {tab === 'backup' && (
          <div className="stack">
            <p className="hint">Ручной запуск бэкапа (роль maint и выше).</p>
            <div>
              <Button disabled={busy} onClick={() => void runBackup()} type="button">
                <DatabaseBackup size={14} /> {busy ? 'Запуск…' : 'Запустить бэкап'}
              </Button>
            </div>
            {status && (
              <pre className="code-block" style={{ maxHeight: 240 }}>
                {status}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
