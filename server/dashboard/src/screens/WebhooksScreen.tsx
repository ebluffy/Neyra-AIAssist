import { useCallback, useEffect, useMemo, useState } from 'react'
import { FlaskConical, KeyRound, RefreshCw, RotateCcw, Save, Trash2, Webhook } from 'lucide-react'
import { apiDelete, apiGet, apiPatch, apiPost } from '../api'
import type { ApiEnvelope, WebhookDelivery, WebhookEventTypes, WebhookRoute } from '../api'
import { Button } from '../components/ui/button'
import { EmptyState } from '../components/ui/empty-state'
import { InlineFeedback } from '../components/ui/inline-feedback'
import { PageHeader } from '../components/ui/page-header'

const ALL_EVENTS = '*'
const mono = { fontFamily: 'var(--mono)', fontSize: '0.78rem' } as const

function statusClass(s: string): string {
  const v = (s || '').toLowerCase()
  if (/(deliver|success|ok|sent)/.test(v)) return 'status-ok'
  if (/(fail|error|dead|dlq)/.test(v)) return 'status-error'
  if (/(pend|retry|queue)/.test(v)) return 'status-warn'
  return 'status-idle'
}

function StatusBadge({ value }: { value: string }) {
  return (
    <span className={`status-badge ${statusClass(value)}`} style={{ padding: '0.15rem 0.55rem', fontSize: '0.72rem' }}>
      {value || '—'}
    </span>
  )
}

function fmtTime(s?: string): string {
  if (!s) return '—'
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString('ru-RU')
}

function randomSecret(): string {
  const buf = new Uint8Array(24)
  crypto.getRandomValues(buf)
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
}

function DeliveryTable({
  rows,
  empty,
  onRetry,
}: {
  rows: WebhookDelivery[]
  empty: string
  onRetry: (id: string) => void
}) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {['Время', 'Событие', 'Маршрут', 'Статус', 'HTTP', 'Попытки', 'Ошибка', ''].map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={8}>
                <EmptyState icon={FlaskConical} title={empty} description="" />
              </td>
            </tr>
          ) : (
            rows.slice(0, 30).map((d) => (
              <tr key={d.delivery_id}>
                <td style={{ ...mono, whiteSpace: 'nowrap' }}>{fmtTime(d.updated_at || d.created_at)}</td>
                <td style={mono}>{d.event_type || '—'}</td>
                <td style={mono}>{d.route_id}</td>
                <td>
                  <StatusBadge value={d.status} />
                </td>
                <td style={mono}>{d.status_code ?? '—'}</td>
                <td>{d.attempts}</td>
                <td style={{ ...mono, wordBreak: 'break-all', maxWidth: 280 }}>{d.error || '—'}</td>
                <td>
                  <button
                    aria-label="Повторить"
                    className="btn btn-secondary btn-sm"
                    onClick={() => onRetry(d.delivery_id)}
                    style={{ padding: '0.3rem 0.5rem' }}
                    title="Повторить"
                    type="button"
                  >
                    <RotateCcw size={13} />
                  </button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}

export function WebhooksScreen() {
  const [routes, setRoutes] = useState<WebhookRoute[]>([])
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([])
  const [dlq, setDlq] = useState<WebhookDelivery[]>([])
  const [eventTypes, setEventTypes] = useState<WebhookEventTypes | null>(null)

  // Form (one "panel" = one target URL with a set of events)
  const [formReady, setFormReady] = useState(false)
  const [enabled, setEnabled] = useState(true)
  const [url, setUrl] = useState('')
  const [secret, setSecret] = useState('')
  const [events, setEvents] = useState<Set<string>>(new Set())
  const [groupUrl, setGroupUrl] = useState('')
  const [testEvent, setTestEvent] = useState('')

  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)

  const group = useMemo(
    () => (groupUrl ? routes.filter((r) => r.target_url === groupUrl) : []),
    [routes, groupUrl],
  )
  const savedMask = group.find((r) => r.secret_masked)?.secret_masked ?? ''

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [r, d, q, et] = await Promise.all([
        apiGet<ApiEnvelope<{ routes: WebhookRoute[] }>>('/v1/webhooks/out/routes'),
        apiGet<ApiEnvelope<{ deliveries: WebhookDelivery[] }>>('/v1/webhooks/deliveries'),
        apiGet<ApiEnvelope<{ items?: WebhookDelivery[]; deliveries?: WebhookDelivery[] } | WebhookDelivery[]>>(
          '/v1/webhooks/dlq',
        ),
        apiGet<ApiEnvelope<WebhookEventTypes>>('/v1/webhooks/event-types'),
      ])
      const list = r.data.routes ?? []
      setRoutes(list)
      setDeliveries(d.data.deliveries ?? [])
      const raw = q.data
      setDlq(Array.isArray(raw) ? raw : raw.items ?? raw.deliveries ?? [])
      setEventTypes(et.data)
      if (!formReady) {
        // First load: fill the form from the first existing route's target.
        const first = list[0]
        if (first) {
          const same = list.filter((x) => x.target_url === first.target_url)
          setGroupUrl(first.target_url)
          setUrl(first.target_url)
          setEnabled(same.some((x) => x.enabled))
          setEvents(new Set(same.map((x) => x.event_type)))
        }
        setFormReady(true)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [formReady])

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function toggleEvent(ev: string, on: boolean) {
    setEvents((prev) => {
      const next = new Set(prev)
      if (ev === ALL_EVENTS) {
        next.clear()
        if (on) next.add(ALL_EVENTS)
        return next
      }
      next.delete(ALL_EVENTS)
      if (on) next.add(ev)
      else next.delete(ev)
      return next
    })
  }

  async function save() {
    const target = url.trim()
    if (!/^https?:\/\/.{3,}/i.test(target)) {
      setError('Укажи корректный URL (http:// или https://)')
      return
    }
    if (events.size === 0) {
      setError('Выбери хотя бы одно событие')
      return
    }
    setError(null)
    setSaving(true)
    setStatus('Сохраняю…')
    try {
      const sec = secret.trim()
      const existing = new Map(group.map((r) => [r.event_type, r]))
      let created = 0
      let updated = 0
      let removed = 0
      for (const r of group) {
        if (!events.has(r.event_type)) {
          await apiDelete<ApiEnvelope<unknown>>(`/v1/webhooks/out/routes/${r.route_id}`)
          removed += 1
        }
      }
      for (const ev of events) {
        const cur = existing.get(ev)
        if (cur) {
          await apiPatch<ApiEnvelope<WebhookRoute>>(`/v1/webhooks/out/routes/${cur.route_id}`, {
            target_url: target,
            enabled,
            ...(sec ? { secret: sec } : {}),
          })
          updated += 1
        } else {
          await apiPost<ApiEnvelope<WebhookRoute>>('/v1/webhooks/out/routes', {
            event_type: ev,
            target_url: target,
            secret: sec,
            enabled,
            max_retries: 3,
          })
          created += 1
        }
      }
      setGroupUrl(target)
      setSecret('')
      setStatus(`Сохранено: создано ${created}, обновлено ${updated}, удалено ${removed}.`)
      await load()
    } catch (e) {
      setStatus('')
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  async function sendTest() {
    if (group.length === 0) {
      setError('Сначала сохрани настройки — тест идёт через сохранённый маршрут.')
      return
    }
    const route = testEvent
      ? group.find((r) => r.event_type === testEvent) ?? group.find((r) => r.event_type === ALL_EVENTS)
      : group.find((r) => r.enabled) ?? group[0]
    if (!route) {
      setError(`Для события «${testEvent}» нет сохранённого маршрута. Отметь событие и сохрани.`)
      return
    }
    setError(null)
    setTesting(true)
    try {
      await apiPost<ApiEnvelope<unknown>>(`/v1/webhooks/out/test/${route.route_id}`, {
        payload: testEvent
          ? { ping: true, source: 'ui_test', test_event_type: testEvent }
          : { ping: true, source: 'ui_test' },
      })
      setStatus(testEvent ? `Тест «${testEvent}» отправлен.` : 'Обычный тест отправлен.')
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setTesting(false)
    }
  }

  async function toggleRoute(route: WebhookRoute) {
    setError(null)
    try {
      await apiPatch<ApiEnvelope<WebhookRoute>>(`/v1/webhooks/out/routes/${route.route_id}`, { enabled: !route.enabled })
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function deleteRoute(route: WebhookRoute) {
    if (!window.confirm(`Удалить маршрут ${route.route_id} (${route.event_type})?`)) return
    setError(null)
    try {
      await apiDelete<ApiEnvelope<unknown>>(`/v1/webhooks/out/routes/${route.route_id}`)
      if (route.target_url === groupUrl) {
        setEvents((prev) => {
          const next = new Set(prev)
          next.delete(route.event_type)
          return next
        })
      }
      await load()
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

  const groups = eventTypes?.groups ?? {}
  const groupNames = Object.keys(groups).sort()
  const allSelected = events.has(ALL_EVENTS)

  return (
    <div className="page-content stack">
      <PageHeader
        title="Вебхуки"
        subtitle="Исходящие уведомления: куда и о каких событиях сообщать"
        actions={
          <Button disabled={loading} onClick={() => void load()} type="button" variant="secondary">
            <RefreshCw size={14} style={loading ? { animation: 'spin 1s linear infinite' } : undefined} />
            Обновить
          </Button>
        }
      />
      {error && <InlineFeedback tone="error">{error}</InlineFeedback>}
      {status && <InlineFeedback tone="success">{status}</InlineFeedback>}

      <div className="card">
        <div className="card-header">
          <Webhook size={15} className="card-icon card-icon-cyan" />
          <span className="card-title">Исходящий вебхук</span>
        </div>

        <div className="stack">
          <div className="switch-row">
            <div>
              <div style={{ fontSize: '0.88rem', fontWeight: 500 }}>Отправка включена</div>
              <div className="hint">Выключенные маршруты остаются в списке, но события не отправляют.</div>
            </div>
            <button
              aria-label="включить или выключить вебхук"
              aria-pressed={enabled}
              className={`toggle-pill ${enabled ? 'toggle-on' : 'toggle-off'}`}
              onClick={() => setEnabled((v) => !v)}
              type="button"
            >
              {enabled ? 'Включён' : 'Выключен'}
            </button>
          </div>

          <div className="field-row">
            <span className="label-text" style={{ paddingTop: '0.6rem', fontSize: '0.8rem' }}>URL назначения</span>
            <input
              className="input input-mono"
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/neyra-webhook"
              value={url}
            />
          </div>

          <div className="field-row">
            <span className="label-text" style={{ paddingTop: '0.6rem', fontSize: '0.8rem' }}>Секрет</span>
            <div className="stack-sm">
              <div className="row" style={{ flexWrap: 'nowrap' }}>
                <input
                  autoComplete="off"
                  className="input input-mono"
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder={savedMask ? `Сохранён: ${savedMask} — оставь пустым, чтобы не менять` : 'Без секрета'}
                  type="password"
                  value={secret}
                />
                <Button onClick={() => setSecret(randomSecret())} size="sm" type="button" variant="secondary">
                  <KeyRound size={13} /> Сгенерировать
                </Button>
              </div>
              <p className="hint">
                Получатель увидит секрет в заголовке <code className="inline-code">x-neyra-webhook-secret</code>. Сверяй
                его на своей стороне. Для новых событий в уже существующем наборе введи секрет заново.
              </p>
            </div>
          </div>

          <div>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div className="section-title" style={{ marginBottom: 0 }}>
                События ({allSelected ? 'все' : events.size})
              </div>
              <Button
                disabled={events.size === 0}
                onClick={() => setEvents(new Set())}
                size="sm"
                type="button"
                variant="secondary"
              >
                Снять все
              </Button>
            </div>
            <label className="check-row" style={{ marginTop: '0.5rem' }}>
              <input checked={allSelected} onChange={(e) => toggleEvent(ALL_EVENTS, e.target.checked)} type="checkbox" />
              * — все события
            </label>
            {!eventTypes && <p className="hint">Загрузка списка событий…</p>}
            {groupNames.map((g) => (
              <div key={g}>
                <div className="event-group-title">{g}</div>
                <div className="event-grid">
                  {groups[g].map((ev) => (
                    <label key={ev} className="check-row" style={allSelected ? { opacity: 0.5 } : undefined}>
                      <input
                        checked={events.has(ev)}
                        onChange={(e) => toggleEvent(ev, e.target.checked)}
                        type="checkbox"
                      />
                      {ev}
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <hr className="divider" style={{ margin: 0 }} />
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div className="row">
              <select
                aria-label="Тип теста"
                className="select"
                onChange={(e) => setTestEvent(e.target.value)}
                style={{ width: 'auto', minWidth: 240 }}
                value={testEvent}
              >
                <option value="">Обычный тест</option>
                {groupNames.map((g) => (
                  <optgroup key={g} label={g}>
                    {groups[g].map((ev) => (
                      <option key={ev} value={ev}>
                        {ev}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <Button disabled={testing || saving} onClick={() => void sendTest()} type="button" variant="cyan">
                <FlaskConical size={14} /> {testing ? 'Отправка…' : 'Тест'}
              </Button>
            </div>
            <Button disabled={saving} onClick={() => void save()} type="button">
              <Save size={14} /> {saving ? 'Сохранение…' : 'Сохранить'}
            </Button>
          </div>
          <p className="hint">
            Тест уходит через сохранённый маршрут. Сначала сохрани изменения, затем проверяй.
          </p>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title">Маршруты ({routes.length})</span>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                {['ID', 'Событие', 'URL', 'Секрет', 'Вкл.', ''].map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {routes.length === 0 ? (
                <tr>
                  <td colSpan={6}>
                    <EmptyState icon={Webhook} title="Нет маршрутов" description="Заполни форму выше и сохрани." />
                  </td>
                </tr>
              ) : (
                routes.map((r) => (
                  <tr key={r.route_id}>
                    <td style={mono}>{r.route_id}</td>
                    <td style={mono}>{r.event_type}</td>
                    <td style={{ ...mono, wordBreak: 'break-all' }}>{r.target_url}</td>
                    <td style={mono}>{r.secret_masked || '—'}</td>
                    <td>
                      <input
                        aria-label={`Маршрут ${r.route_id} включён`}
                        checked={r.enabled}
                        onChange={() => void toggleRoute(r)}
                        type="checkbox"
                      />
                    </td>
                    <td>
                      <button
                        aria-label="Удалить"
                        className="btn btn-danger btn-sm"
                        onClick={() => void deleteRoute(r)}
                        style={{ padding: '0.3rem 0.5rem' }}
                        title="Удалить"
                        type="button"
                      >
                        <Trash2 size={13} />
                      </button>
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
        <DeliveryTable empty="Нет доставок" onRetry={(id) => void retryDelivery(id)} rows={deliveries} />
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title">Очередь ошибок ({dlq.length})</span>
        </div>
        <DeliveryTable empty="Очередь ошибок пуста" onRetry={(id) => void retryDelivery(id)} rows={dlq} />
      </div>
    </div>
  )
}
