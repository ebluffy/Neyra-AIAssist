import { useCallback, useEffect, useState } from 'react'
import { DatabaseBackup, Info, Link2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import { apiGet, apiPost } from '../api'
import type { ApiEnvelope } from '../api'
import { Button } from '../components/ui/button'
import { InlineFeedback } from '../components/ui/inline-feedback'
import { PageHeader } from '../components/ui/page-header'

export function SystemScreen() {
  const [meta, setMeta] = useState<Record<string, unknown> | null>(null)
  const [dlqCount, setDlqCount] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
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
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function runBackup() {
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

  return (
    <div className="page-content stack">
      <PageHeader
        title="Система"
        subtitle="Бэкап, сведения о API и очередь ошибок вебхуков"
        actions={
          <Button onClick={() => void load()} type="button" variant="secondary">
            Обновить
          </Button>
        }
      />
      {error && <InlineFeedback tone="error">{error}</InlineFeedback>}

      <div className="grid-2">
        <div className="card">
          <div className="card-header">
            <Info size={15} className="card-icon card-icon-cyan" />
            <span className="card-title">Сведения API</span>
          </div>
          <pre className="code-block" style={{ maxHeight: 280, overflow: 'auto' }}>
            {meta ? JSON.stringify(meta, null, 2) : '—'}
          </pre>
        </div>
        <div className="card">
          <div className="card-header">
            <DatabaseBackup size={15} className="card-icon" />
            <span className="card-title">Бэкап</span>
          </div>
          <p style={{ fontSize: '0.82rem', color: 'var(--muted)', marginBottom: '0.85rem' }}>
            Ручной запуск бэкапа (роль maint и выше).
          </p>
          <Button disabled={busy} onClick={() => void runBackup()} type="button">
            {busy ? 'Запуск…' : 'Запустить бэкап'}
          </Button>
          {status && (
            <pre className="code-block" style={{ marginTop: '0.85rem', maxHeight: 180, overflow: 'auto' }}>
              {status}
            </pre>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <Link2 size={15} className="card-icon card-icon-pink" />
          <span className="card-title">Очередь ошибок вебхуков</span>
        </div>
        <p style={{ fontSize: '0.85rem', color: 'var(--muted)', marginBottom: '0.75rem' }}>
          Записей в очереди:{' '}
          <strong style={{ color: 'var(--text)', fontFamily: 'var(--mono)' }}>{dlqCount ?? '—'}</strong>
        </p>
        <Link className="btn btn-secondary btn-sm" to="/webhooks">
          Открыть вебхуки
        </Link>
      </div>
    </div>
  )
}
