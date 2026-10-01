import { useCallback, useEffect, useState } from 'react'
import { FlaskConical, Loader2, Plus, RefreshCw, RotateCcw, Trash2, Webhook } from 'lucide-react'
import { apiDelete, apiGet, apiPatch, apiPost } from '../api'
import type { ApiEnvelope, WebhookDelivery, WebhookRoute } from '../api'
import { Button } from '../components/ui/button'
import { EmptyState } from '../components/ui/empty-state'
import { InlineFeedback } from '../components/ui/inline-feedback'
import { PageHeader } from '../components/ui/page-header'

export function WebhooksScreen() {
  const [routes, setRoutes] = useState<WebhookRoute[]>([])
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([])
  const [dlq, setDlq] = useState<WebhookDelivery[]>([])
  const [eventType, setEventType] = useState('chat.turn_completed')
  const [targetUrl, setTargetUrl] = useState('http://127.0.0.1:9999/webhook')
  const [secret, setSecret] = useState('')
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [r, d, q] = await Promise.all([
        apiGet<ApiEnvelope<{ routes: WebhookRoute[] }>>('/v1/webhooks/out/routes'),
        apiGet<ApiEnvelope<{ deliveries: WebhookDelivery[] }>>('/v1/webhooks/deliveries'),
        apiGet<ApiEnvelope<{ items?: WebhookDelivery[]; deliveries?: WebhookDelivery[] } | WebhookDelivery[]>>(
          '/v1/webhooks/dlq',
        ),
      ])
      setRoutes(r.data.routes ?? [])
      setDeliveries(d.data.deliveries ?? [])
      const raw = q.data
      const list = Array.isArray(raw)
        ? raw
        : raw.items ?? raw.deliveries ?? []
      setDlq(list)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function createRoute() {
    setError(null)
    setStatus('Создаю маршрут...')
    try {
      await apiPost<ApiEnvelope<WebhookRoute>>('/v1/webhooks/out/routes', {
        event_type: eventType,
        target_url: targetUrl,
        secret,
        enabled: true,
        max_retries: 3,
      })
      setStatus('Маршрут создан')
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function toggleRoute(route: WebhookRoute, enabled: boolean) {
    setError(null)
    try {
      await apiPatch<ApiEnvelope<WebhookRoute>>(`/v1/webhooks/out/routes/${route.route_id}`, { enabled })
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function deleteRoute(route: WebhookRoute) {
    setError(null)
    try {
      await apiDelete<ApiEnvelope<unknown>>(`/v1/webhooks/out/routes/${route.route_id}`)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function testRoute(route: WebhookRoute) {
    setError(null)
    try {
      await apiPost<ApiEnvelope<unknown>>(`/v1/webhooks/out/test/${route.route_id}`, {
        payload: { ping: true, source: 'ui_test' },
      })
      await load()
      setStatus(`Тест отправлен: ${route.route_id}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function retryDelivery(deliveryId: string) {
    setError(null)
    try {
      await apiPost<ApiEnvelope<unknown>>(`/v1/webhooks/deliveries/${deliveryId}/retry`, { delay_seconds: 0 })
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
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
      <PageHeader
        title="Вебхуки"
        subtitle="Исходящие маршруты, доставки и очередь ошибок"
        actions={
          <Button disabled={loading} onClick={() => void load()} type="button" variant="secondary">
            <RefreshCw size={14} style={loading ? { animation: 'spin 1s linear infinite' } : undefined} />
            Обновить
          </Button>
        }
      />
      {error && <InlineFeedback tone="error">{error}</InlineFeedback>}

      <div className="card">
        <div className="card-header">
          <Webhook size={15} className="card-icon card-icon-cyan" />
          <span className="card-title">Новый маршрут</span>
        </div>
        <div className="grid-3" style={{ marginBottom: '0.85rem' }}>
          <label className="label">
            <span className="label-text">Тип события</span>
            <input className="input input-mono" onChange={(e) => setEventType(e.target.value)} value={eventType} />
          </label>
          <label className="label">
            <span className="label-text">URL назначения</span>
            <input className="input input-mono" onChange={(e) => setTargetUrl(e.target.value)} value={targetUrl} />
          </label>
          <label className="label">
            <span className="label-text">Секрет (необязательно)</span>
            <input className="input input-mono" onChange={(e) => setSecret(e.target.value)} value={secret} />
          </label>
        </div>
        <Button onClick={() => void createRoute()} type="button">
          {loading ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Plus size={14} />}
          Создать
        </Button>
        {status && (
          <div style={{ marginTop: '0.65rem' }}>
            <InlineFeedback tone="success">{status}</InlineFeedback>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title">Маршруты</span>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                {['ID', 'Событие', 'URL', 'Вкл.', 'Действия'].map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {routes.length === 0 ? (
                <tr>
                  <td colSpan={5}>
                    <EmptyState icon={Webhook} title="Нет маршрутов" description="Создай первый маршрут выше." />
                  </td>
                </tr>
              ) : (
                routes.map((r) => (
                  <tr key={r.route_id}>
                    <td>
                      <span style={{ fontFamily: 'var(--mono)', fontSize: '0.78rem' }}>{r.route_id}</span>
                    </td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: '0.78rem' }}>{r.event_type}</td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: '0.78rem', wordBreak: 'break-all' }}>{r.target_url}</td>
                    <td>{r.enabled ? 'да' : 'нет'}</td>
                    <td>
                      <div className="row" style={{ gap: 6 }}>
                        {iconBtn(r.enabled ? 'Выключить' : 'Включить', () => void toggleRoute(r, !r.enabled), '', <RefreshCw size={13} />)}
                        {iconBtn('Тест', () => void testRoute(r), '', <FlaskConical size={13} />)}
                        {iconBtn('Удалить', () => void deleteRoute(r), 'btn-danger', <Trash2 size={13} />)}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title">Доставки</span>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                {['ID доставки', 'Маршрут', 'Статус', 'Попытки', 'Ошибка', 'Повтор'].map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {deliveries.length === 0 ? (
                <tr>
                  <td colSpan={6}>
                    <EmptyState icon={FlaskConical} title="Нет доставок" description="Появятся после теста." />
                  </td>
                </tr>
              ) : (
                deliveries.slice(0, 30).map((d) => (
                  <tr key={d.delivery_id}>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: '0.78rem' }}>{d.delivery_id}</td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: '0.78rem' }}>{d.route_id}</td>
                    <td>{d.status}</td>
                    <td>{d.attempts}</td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: '0.75rem', wordBreak: 'break-all' }}>{d.error || '—'}</td>
                    <td>{iconBtn('Повторить', () => void retryDelivery(d.delivery_id), '', <RotateCcw size={13} />)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title">Очередь ошибок ({dlq.length})</span>
        </div>
        <pre className="code-block" style={{ maxHeight: 240, overflow: 'auto' }}>
          {JSON.stringify(dlq.slice(0, 30), null, 2)}
        </pre>
      </div>
    </div>
  )
}
