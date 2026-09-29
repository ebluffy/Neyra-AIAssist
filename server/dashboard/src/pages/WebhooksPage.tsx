import { useCallback, useEffect, useState } from 'react'
import { FlaskConical, Loader2, Plus, RefreshCw, RotateCcw, Trash2, Webhook } from 'lucide-react'
import { apiDelete, apiGet, apiPatch, apiPost } from '../api'
import { Button } from '../components/ui/button'
import { EmptyState } from '../components/ui/empty-state'
import { InlineFeedback } from '../components/ui/inline-feedback'
import type { ApiEnvelope, WebhookDelivery, WebhookRoute } from '../types'

export function WebhooksPage() {
  const [routes, setRoutes] = useState<WebhookRoute[]>([])
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([])
  const [eventType, setEventType] = useState('chat.turn_completed')
  const [targetUrl, setTargetUrl] = useState('http://127.0.0.1:9999/webhook')
  const [secret, setSecret] = useState('')
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const [r, d] = await Promise.all([
      apiGet<ApiEnvelope<{ routes: WebhookRoute[] }>>('/v1/webhooks/out/routes'),
      apiGet<ApiEnvelope<{ deliveries: WebhookDelivery[] }>>('/v1/webhooks/deliveries'),
    ])
    setRoutes(r.data.routes ?? [])
    setDeliveries(d.data.deliveries ?? [])
    setLoading(false)
  }, [])

  useEffect(() => { void load() }, [load])

  async function createRoute() {
    setError(null); setStatus('Создаю маршрут...')
    try {
      await apiPost<ApiEnvelope<WebhookRoute>>('/v1/webhooks/out/routes', { event_type: eventType, target_url: targetUrl, secret, enabled: true, max_retries: 3 })
      setStatus('Маршрут создан'); await load()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function toggleRoute(route: WebhookRoute, enabled: boolean) {
    setError(null)
    try { await apiPatch<ApiEnvelope<WebhookRoute>>(`/v1/webhooks/out/routes/${route.route_id}`, { enabled }); await load() }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function deleteRoute(route: WebhookRoute) {
    setError(null)
    try { await apiDelete<ApiEnvelope<unknown>>(`/v1/webhooks/out/routes/${route.route_id}`); await load() }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function testRoute(route: WebhookRoute) {
    setError(null)
    try {
      await apiPost<ApiEnvelope<unknown>>(`/v1/webhooks/out/test/${route.route_id}`, { payload: { ping: true, source: 'ui_test' } })
      await load(); setStatus(`Тест отправлен: ${route.route_id}`)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function retryDelivery(deliveryId: string) {
    setError(null)
    try { await apiPost<ApiEnvelope<unknown>>(`/v1/webhooks/deliveries/${deliveryId}/retry`, { delay_seconds: 0 }); await load() }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  const iconBtn = (label: string, onClick: () => void, colorClass: string, icon: React.ReactNode) => (
    <button
      aria-label={label}
      className={`btn btn-secondary btn-sm ${colorClass}`}
      onClick={onClick}
      style={{ padding: '0.3rem 0.5rem' }}
      title={label}
      type="button"
    >
      {icon}
    </button>
  )

  return (
    <div className="page-content stack">
      <div className="page-header" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem' }}>
        <div>
          <h1 className="page-title">Вебхуки</h1>
          <p className="page-sub">Outbound маршруты и лог доставок / DLQ</p>
        </div>
        <Button disabled={loading} onClick={() => void load()} type="button" variant="secondary">
          <RefreshCw size={14} style={loading ? { animation: 'spin 1s linear infinite' } : {}} />
          Обновить
        </Button>
      </div>

      {error && <InlineFeedback tone="error">{error}</InlineFeedback>}

      {/* Create form */}
      <div className="card">
        <div className="card-header">
          <Webhook size={15} className="card-icon card-icon-cyan" />
          <span className="card-title">Новый маршрут (outbound)</span>
        </div>
        <div className="grid-3" style={{ marginBottom: '0.85rem' }}>
          <label className="label">
            <span className="label-text">event_type</span>
            <input className="input input-mono" onChange={(e) => setEventType(e.target.value)} value={eventType} />
          </label>
          <label className="label">
            <span className="label-text">target_url</span>
            <input className="input input-mono" onChange={(e) => setTargetUrl(e.target.value)} value={targetUrl} />
          </label>
          <label className="label">
            <span className="label-text">secret (optional)</span>
            <input className="input input-mono" onChange={(e) => setSecret(e.target.value)} value={secret} />
          </label>
        </div>
        <div className="row">
          <Button onClick={() => void createRoute()} type="button">
            {loading ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Plus size={14} />}
            Создать маршрут
          </Button>
        </div>
        {status && <div style={{ marginTop: '0.65rem' }}><InlineFeedback tone="success">{status}</InlineFeedback></div>}
        {!status && <p style={{ marginTop: '0.65rem', fontSize: '0.8rem', color: 'var(--muted)' }}>Создай маршрут и протестируй доставку.</p>}
      </div>

      {/* Routes table */}
      <div className="card">
        <div className="card-header">
          <Webhook size={15} className="card-icon" />
          <span className="card-title">Маршруты</span>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead><tr>
              {['ID', 'event_type', 'target', 'enabled', 'Действия'].map((h) => <th key={h}>{h}</th>)}
            </tr></thead>
            <tbody>
              {routes.length === 0 ? (
                <tr><td colSpan={5}><EmptyState icon={Webhook} title="Нет маршрутов" description="Создай первый webhook route выше." /></td></tr>
              ) : routes.map((r) => (
                <tr key={r.route_id}>
                  <td><span style={{ fontFamily: 'var(--mono)', fontSize: '0.78rem' }}>{r.route_id}</span></td>
                  <td style={{ fontFamily: 'var(--mono)', fontSize: '0.78rem' }}>{r.event_type}</td>
                  <td style={{ fontFamily: 'var(--mono)', fontSize: '0.78rem', wordBreak: 'break-all' }}>{r.target_url}</td>
                  <td>
                    <span className={`status-badge ${r.enabled ? 'status-ok' : 'status-idle'}`} style={{ padding: '0.2rem 0.6rem', fontSize: '0.73rem' }}>
                      <span className={`status-dot ${r.enabled ? 'status-dot-ok' : 'status-dot-idle'}`} />
                      {r.enabled ? 'yes' : 'no'}
                    </span>
                  </td>
                  <td>
                    <div className="row" style={{ gap: 6 }}>
                      {iconBtn(r.enabled ? 'Disable' : 'Enable', () => void toggleRoute(r, !r.enabled), '', <RefreshCw size={13} />)}
                      {iconBtn('Test', () => void testRoute(r), '', <FlaskConical size={13} />)}
                      {iconBtn('Delete', () => void deleteRoute(r), 'btn-danger', <Trash2 size={13} />)}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Deliveries table */}
      <div className="card">
        <div className="card-header">
          <FlaskConical size={15} className="card-icon card-icon-pink" />
          <span className="card-title">Deliveries / DLQ</span>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead><tr>
              {['delivery_id', 'route_id', 'status', 'attempts', 'error', 'retry'].map((h) => <th key={h}>{h}</th>)}
            </tr></thead>
            <tbody>
              {deliveries.length === 0 ? (
                <tr><td colSpan={6}><EmptyState icon={FlaskConical} title="Нет доставок" description="Появятся после теста или реальной отправки." /></td></tr>
              ) : deliveries.slice(0, 30).map((d) => (
                <tr key={d.delivery_id}>
                  <td style={{ fontFamily: 'var(--mono)', fontSize: '0.78rem' }}>{d.delivery_id}</td>
                  <td style={{ fontFamily: 'var(--mono)', fontSize: '0.78rem' }}>{d.route_id}</td>
                  <td>{d.status}</td>
                  <td>{d.attempts}</td>
                  <td style={{ fontFamily: 'var(--mono)', fontSize: '0.75rem', wordBreak: 'break-all' }}>{d.error || '—'}</td>
                  <td>
                    {iconBtn('Retry', () => void retryDelivery(d.delivery_id), '', <RotateCcw size={13} />)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
