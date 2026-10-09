import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { ChevronDown, ChevronRight, FlaskConical, KeyRound, RefreshCw, RotateCcw, Save, Trash2, Webhook } from 'lucide-react'
import { apiDelete, apiGet, apiPatch, apiPost } from '../api'
import type { ApiEnvelope, WebhookDelivery, WebhookEventTypes, WebhookRoute } from '../api'
import { Button } from '../components/ui/button'
import { DangerConfirmDialog } from '../components/ui/danger-confirm-dialog'
import { EmptyState } from '../components/ui/empty-state'
import { InlineFeedback } from '../components/ui/inline-feedback'
import { PageHeader } from '../components/ui/page-header'
import { Switch } from '../components/ui/switch'
import { webhookOutboundSchema, type WebhookOutboundValues } from '../lib/webhook-form'

const ALL_EVENTS = '*'
const NEW_URL = '__new__'
const DEFAULT_RETRIES = 3
const mono = { fontFamily: 'var(--mono)', fontSize: '0.78rem' } as const

type TopTab = 'out' | 'in'

const STATUS_FILTERS: [string, string][] = [
  ['', 'Все статусы'],
  ['ok', 'ok'],
  ['failed', 'failed'],
  ['pending', 'pending'],
]

const INBOUND_PROVIDERS: { id: string; label: string; note: string }[] = [
  { id: 'generic', label: 'generic', note: 'Любой JSON с полем text / message / content.' },
  { id: 'github', label: 'github', note: 'Заглушка под события GitHub (пока как generic).' },
  { id: 'custom', label: 'custom', note: 'Свой источник: имя провайдера подставляется в путь.' },
]

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

function fmtPayload(v: unknown): string {
  if (v == null || v === '') return '—'
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

function DeliveryTable({
  rows,
  empty,
  onRetry,
  highlightId,
}: {
  rows: WebhookDelivery[]
  empty: string
  onRetry: (id: string) => void
  highlightId?: string
}) {
  const [open, setOpen] = useState<string>('')
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {['', 'Время', 'Событие', 'Маршрут', 'Статус', 'HTTP', 'Попытки', 'Ошибка', ''].map((h, i) => (
              <th key={`${h}${i}`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={9}>
                <EmptyState icon={FlaskConical} title={empty} description="" />
              </td>
            </tr>
          ) : (
            rows.slice(0, 30).map((d) => {
              const isOpen = open === d.delivery_id
              return (
                <Fragment key={d.delivery_id}>
                  <tr className={highlightId && highlightId === d.delivery_id ? 'row-highlight' : undefined}>
                    <td>
                      <button
                        aria-expanded={isOpen}
                        aria-label={isOpen ? `Свернуть доставку ${d.delivery_id}` : `Развернуть доставку ${d.delivery_id}`}
                        className="btn btn-secondary btn-sm btn-icon"
                        onClick={() => setOpen(isOpen ? '' : d.delivery_id)}
                        type="button"
                      >
                        {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                      </button>
                    </td>
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
                        aria-label={`Повторить доставку ${d.delivery_id}`}
                        className="btn btn-secondary btn-sm btn-icon"
                        onClick={() => onRetry(d.delivery_id)}
                        title="Повторить"
                        type="button"
                      >
                        <RotateCcw aria-hidden size={13} />
                      </button>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={9}>
                        <div className="grid-2">
                          <div>
                            <div className="section-title">Payload</div>
                            <pre className="code-block" style={{ maxHeight: 220 }}>{fmtPayload(d.payload)}</pre>
                          </div>
                          <div>
                            <div className="section-title">Ответ получателя</div>
                            <pre className="code-block" style={{ maxHeight: 220 }}>{fmtPayload(d.response_text)}</pre>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })
          )}
        </tbody>
      </table>
    </div>
  )
}

function InboundPanel() {
  const [endpointId, setEndpointId] = useState('default')
  const [pingBusy, setPingBusy] = useState('')
  const [pingMsg, setPingMsg] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)

  const eid = endpointId.trim() || 'default'

  async function ping(provider: string) {
    const path = `/v1/webhooks/in/${encodeURIComponent(provider)}/${encodeURIComponent(eid)}/health`
    setPingBusy(provider)
    setPingMsg(null)
    try {
      const r = await apiGet<ApiEnvelope<{ status?: string }>>(path)
      setPingMsg({ tone: 'success', text: `${provider}: ${r.data.status ?? 'ok'} (${path})` })
    } catch (e) {
      setPingMsg({ tone: 'error', text: `${provider}: ${e instanceof Error ? e.message : String(e)}` })
    } finally {
      setPingBusy('')
    }
  }

  return (
    <div className="card">
      <div className="card-header">
        <Webhook size={15} className="card-icon card-icon-pink" />
        <span className="card-title">Входящие вебхуки</span>
      </div>
      <div className="stack">
        <p className="hint">
          Входящие запросы принимает <code className="inline-code">POST /v1/webhooks/in/&#123;provider&#125;/&#123;endpoint_id&#125;</code>.
          Текст из <code className="inline-code">text</code> / <code className="inline-code">message</code> /{' '}
          <code className="inline-code">content</code> уходит в чат Нейры, событие публикуется в шину ядра. Управление
          эндпоинтами пока без интерфейса — это каркас.
        </p>
        <label className="field-row">
          <span className="label-text" style={{ paddingTop: '0.6rem', fontSize: '0.8rem' }}>endpoint_id</span>
          <input
            aria-label="endpoint_id"
            className="input input-mono"
            onChange={(e) => setEndpointId(e.target.value)}
            placeholder="default"
            value={endpointId}
          />
        </label>
        {pingMsg && <InlineFeedback tone={pingMsg.tone}>{pingMsg.text}</InlineFeedback>}
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                {['Провайдер', 'Путь', 'Заметка', ''].map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {INBOUND_PROVIDERS.map((p) => (
                <tr key={p.id}>
                  <td style={mono}>{p.label}</td>
                  <td style={{ ...mono, wordBreak: 'break-all' }}>POST /v1/webhooks/in/{p.id}/{eid}</td>
                  <td className="hint">{p.note}</td>
                  <td>
                    <Button
                      disabled={pingBusy !== ''}
                      onClick={() => void ping(p.id)}
                      size="sm"
                      type="button"
                      variant="secondary"
                    >
                      {pingBusy === p.id ? 'Проверяю…' : 'Health'}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="hint">
          Health-пинг — это <code className="inline-code">GET &lt;путь&gt;/health</code>, нужен Bearer-токен (viewer и выше).
          Подпись входящих: если в конфиге задан <code className="inline-code">api.webhook_inbound_secret</code>, запрос
          должен нести заголовок <code className="inline-code">X-Neyra-Signature: sha256=&lt;hex&gt;</code> — HMAC-SHA256
          сырого тела запроса этим секретом. Без секрета в конфиге проверка выключена.
        </p>
      </div>
    </div>
  )
}

export function WebhooksScreen() {
  const [topTab, setTopTab] = useState<TopTab>('out')
  const [routes, setRoutes] = useState<WebhookRoute[]>([])
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([])
  const [dlq, setDlq] = useState<WebhookDelivery[]>([])
  const [eventTypes, setEventTypes] = useState<WebhookEventTypes | null>(null)
  const [statusFilter, setStatusFilter] = useState('')
  const statusFilterRef = useRef('')
  const [highlightId, setHighlightId] = useState('')

  // Form (one "panel" = one target URL with a set of events)
  const [formReady, setFormReady] = useState(false)
  const [groupUrl, setGroupUrl] = useState('')
  const [testEvent, setTestEvent] = useState('')
  const form = useForm<WebhookOutboundValues>({
    resolver: zodResolver(webhookOutboundSchema),
    defaultValues: {
      enabled: true,
      url: '',
      secret: '',
      maxRetries: DEFAULT_RETRIES,
      events: [],
    },
  })
  const eventsList = form.watch('events') ?? []
  const events = useMemo(() => new Set(eventsList), [eventsList])

  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [retryAllBusy, setRetryAllBusy] = useState(false)
  const [danger, setDanger] = useState<
    null | { kind: 'delete-route'; route: WebhookRoute } | { kind: 'retry-all-dlq' }
  >(null)
  const [dangerBusy, setDangerBusy] = useState(false)

  const group = useMemo(
    () => (groupUrl ? routes.filter((r) => r.target_url === groupUrl) : []),
    [routes, groupUrl],
  )
  const savedMask = group.find((r) => r.secret_masked)?.secret_masked ?? ''
  const destinations = useMemo(() => Array.from(new Set(routes.map((r) => r.target_url))), [routes])

  const applyGroup = useCallback(
    (list: WebhookRoute[], target: string) => {
      const same = list.filter((x) => x.target_url === target)
      setGroupUrl(target)
      form.reset({
        enabled: same.length === 0 ? true : same.some((x) => x.enabled),
        url: target,
        secret: '',
        maxRetries: same[0]?.max_retries ?? DEFAULT_RETRIES,
        events: same.map((x) => x.event_type),
      })
    },
    [form],
  )

  const loadDeliveries = useCallback(async (filter: string) => {
    const q = filter ? `?status=${encodeURIComponent(filter)}` : ''
    const d = await apiGet<ApiEnvelope<{ deliveries: WebhookDelivery[] }>>(`/v1/webhooks/deliveries${q}`)
    setDeliveries(d.data.deliveries ?? [])
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const filter = statusFilterRef.current
      const [r, d, q, et] = await Promise.all([
        apiGet<ApiEnvelope<{ routes: WebhookRoute[] }>>('/v1/webhooks/out/routes'),
        apiGet<ApiEnvelope<{ deliveries: WebhookDelivery[] }>>(
          `/v1/webhooks/deliveries${filter ? `?status=${encodeURIComponent(filter)}` : ''}`,
        ),
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
        if (first) applyGroup(list, first.target_url)
        setFormReady(true)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [formReady, applyGroup])

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!highlightId) return
    const t = window.setTimeout(() => setHighlightId(''), 6000)
    return () => window.clearTimeout(t)
  }, [highlightId])

  function pickDestination(value: string) {
    if (value === NEW_URL) {
      setGroupUrl('')
      form.reset({
        enabled: true,
        url: '',
        secret: '',
        maxRetries: DEFAULT_RETRIES,
        events: [],
      })
      return
    }
    applyGroup(routes, value)
  }

  function onStatusFilter(v: string) {
    setStatusFilter(v)
    statusFilterRef.current = v
    setError(null)
    loadDeliveries(v).catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }

  function toggleEvent(ev: string, on: boolean) {
    const prev = new Set(form.getValues('events'))
    if (ev === ALL_EVENTS) {
      prev.clear()
      if (on) prev.add(ALL_EVENTS)
    } else {
      prev.delete(ALL_EVENTS)
      if (on) prev.add(ev)
      else prev.delete(ev)
    }
    form.setValue('events', Array.from(prev), { shouldValidate: true, shouldDirty: true })
  }

  async function save(values: WebhookOutboundValues) {
    const target = values.url.trim()
    const retries = values.maxRetries
    const eventSet = new Set(values.events)
    setError(null)
    setSaving(true)
    setStatus('Сохраняю…')
    try {
      const sec = values.secret.trim()
      const existing = new Map(group.map((r) => [r.event_type, r]))
      let created = 0
      let updated = 0
      let removed = 0
      for (const r of group) {
        if (!eventSet.has(r.event_type)) {
          await apiDelete<ApiEnvelope<unknown>>(`/v1/webhooks/out/routes/${r.route_id}`)
          removed += 1
        }
      }
      for (const ev of eventSet) {
        const cur = existing.get(ev)
        if (cur) {
          await apiPatch<ApiEnvelope<WebhookRoute>>(`/v1/webhooks/out/routes/${cur.route_id}`, {
            target_url: target,
            enabled: values.enabled,
            max_retries: retries,
            ...(sec ? { secret: sec } : {}),
          })
          updated += 1
        } else {
          // Empty secret: API copies from another route with the same target_url.
          await apiPost<ApiEnvelope<WebhookRoute>>('/v1/webhooks/out/routes', {
            event_type: ev,
            target_url: target,
            secret: sec,
            enabled: values.enabled,
            max_retries: retries,
          })
          created += 1
        }
      }
      setGroupUrl(target)
      form.setValue('secret', '')
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
      const r = await apiPost<ApiEnvelope<{ delivery_id?: string }>>(`/v1/webhooks/out/test/${route.route_id}`, {
        payload: testEvent
          ? { ping: true, source: 'ui_test', test_event_type: testEvent }
          : { ping: true, source: 'ui_test' },
      })
      setStatus(testEvent ? `Тест «${testEvent}» отправлен.` : 'Обычный тест отправлен.')
      await load()
      if (r.data?.delivery_id) setHighlightId(r.data.delivery_id)
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
    setDanger({ kind: 'delete-route', route })
  }

  async function doDeleteRoute(route: WebhookRoute) {
    setDangerBusy(true)
    setError(null)
    try {
      await apiDelete<ApiEnvelope<unknown>>(`/v1/webhooks/out/routes/${route.route_id}`)
      if (route.target_url === groupUrl) {
        form.setValue(
          'events',
          form.getValues('events').filter((ev) => ev !== route.event_type),
          { shouldDirty: true },
        )
      }
      await load()
      setDanger(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setDanger(null)
    } finally {
      setDangerBusy(false)
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

  async function retryAllDlq() {
    if (dlq.length === 0) return
    setDanger({ kind: 'retry-all-dlq' })
  }

  async function doRetryAllDlq() {
    setDanger(null)
    setError(null)
    setRetryAllBusy(true)
    try {
      const r = await apiPost<ApiEnvelope<{ accepted?: boolean; queued?: number }>>(
        '/v1/webhooks/dlq/retry-all',
        {},
      )
      const queued = r.data.queued ?? dlq.length
      setStatus(`Повтор очереди принят: ${queued} записей в фоне. Обновляю список…`)
      // Background retries finish shortly; give them a moment then refresh DLQ.
      await new Promise((resolve) => window.setTimeout(resolve, 800))
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRetryAllBusy(false)
    }
  }

  const groups = eventTypes?.groups ?? {}
  const groupNames = Object.keys(groups).sort()
  const allSelected = events.has(ALL_EVENTS)
  const destValue = groupUrl && destinations.includes(groupUrl) ? groupUrl : NEW_URL

  const topTabs: [TopTab, string][] = [
    ['out', 'Исходящие'],
    ['in', 'Входящие'],
  ]

  return (
    <div className="page-content stack">
      <PageHeader
        title="Вебхуки"
        subtitle="Исходящие уведомления и приём входящих запросов"
        actions={
          <Button disabled={loading} onClick={() => void load()} type="button" variant="secondary">
            <RefreshCw size={14} style={loading ? { animation: 'spin 1s linear infinite' } : undefined} />
            Обновить
          </Button>
        }
      />
      {error && <InlineFeedback tone="error">{error}</InlineFeedback>}
      {status && <InlineFeedback tone="success">{status}</InlineFeedback>}

      <div className="panel-tabs panel-tabs-dense" role="tablist" style={{ marginBottom: 0 }}>
        {topTabs.map(([id, label]) => (
          <button
            key={id}
            aria-selected={topTab === id}
            className={`panel-tab${topTab === id ? ' active' : ''}`}
            onClick={() => setTopTab(id)}
            role="tab"
            type="button"
          >
            {label}
          </button>
        ))}
      </div>

      {topTab === 'in' && <InboundPanel />}

      {topTab === 'out' && (
        <>
          <div className="card">
            <div className="card-header">
              <Webhook size={15} className="card-icon card-icon-cyan" />
              <span className="card-title">Исходящий вебхук</span>
            </div>

            <form
              className="stack"
              onSubmit={form.handleSubmit(
                (values) => void save(values),
                (errs) => {
                  const first =
                    errs.url?.message ||
                    errs.events?.message ||
                    errs.maxRetries?.message ||
                    errs.secret?.message ||
                    'Проверь форму'
                  setError(String(first))
                },
              )}
            >
              <div className="switch-row">
                <div>
                  <div style={{ fontSize: '0.88rem', fontWeight: 500 }}>Отправка включена</div>
                  <div className="hint">Выключенные маршруты остаются в списке, но события не отправляют.</div>
                </div>
                <Controller
                  control={form.control}
                  name="enabled"
                  render={({ field }) => (
                    <label className="row" style={{ gap: 10, minHeight: 40 }}>
                      <Switch
                        aria-label="Включить или выключить исходящий вебхук"
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                      <span className="hint">{field.value ? 'Включён' : 'Выключен'}</span>
                    </label>
                  )}
                />
              </div>

              <div className="field-row">
                <span className="label-text" style={{ paddingTop: '0.6rem', fontSize: '0.8rem' }}>Назначение</span>
                <select
                  aria-label="Назначение"
                  className="select"
                  onChange={(e) => pickDestination(e.target.value)}
                  value={destValue}
                >
                  {destinations.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                  <option value={NEW_URL}>+ Новый URL</option>
                </select>
              </div>

              <div className="field-row">
                <span className="label-text" style={{ paddingTop: '0.6rem', fontSize: '0.8rem' }}>URL назначения</span>
                <div className="row-tools">
                  <input
                    className="input input-mono"
                    placeholder="https://example.com/neyra-webhook"
                    {...form.register('url')}
                  />
                  <select
                    aria-label="Тип теста"
                    className="select min-w-test w-auto"
                    onChange={(e) => setTestEvent(e.target.value)}
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
              </div>
              <p className="hint" style={{ marginTop: '-0.5rem' }}>
                Тест уходит через сохранённый маршрут. Сначала сохрани изменения, затем проверяй.
              </p>

              <div className="field-row">
                <span className="label-text" style={{ paddingTop: '0.6rem', fontSize: '0.8rem' }}>Секрет</span>
                <div className="stack-sm">
                  <div className="row-tools">
                    <input
                      autoComplete="off"
                      className="input input-mono"
                      placeholder={savedMask ? `Сохранён: ${savedMask} — оставь пустым, чтобы не менять` : 'Без секрета'}
                      type="password"
                      {...form.register('secret')}
                    />
                    <Button
                      className="shrink-0"
                      onClick={() => form.setValue('secret', randomSecret(), { shouldDirty: true })}
                      size="sm"
                      type="button"
                      variant="secondary"
                    >
                      <KeyRound aria-hidden size={13} /> Сгенерировать
                    </Button>
                  </div>
                  <p className="hint">
                    Если секрет задан, каждый запрос несёт заголовок{' '}
                    <code className="inline-code">x-neyra-webhook-secret</code> (сам секрет) и подпись:{' '}
                    <code className="inline-code">X-Neyra-Timestamp</code> (unix-время) и{' '}
                    <code className="inline-code">X-Neyra-Signature: sha256=&lt;hex&gt;</code> — HMAC-SHA256 от строки{' '}
                    <code className="inline-code">timestamp.body</code> (время, точка, сырое тело) с этим секретом. Для
                    новых событий в уже существующем наборе введи секрет заново.
                  </p>
                </div>
              </div>

              <div className="field-row">
                <span className="label-text" style={{ paddingTop: '0.6rem', fontSize: '0.8rem' }}>Повторы</span>
                <div className="stack-sm">
                  <input
                    className="input input-mono"
                    max={10}
                    min={0}
                    style={{ maxWidth: 120 }}
                    type="number"
                    {...form.register('maxRetries', { valueAsNumber: true })}
                  />
                  <p className="hint">Сколько раз повторять неудачную доставку (0–10).</p>
                </div>
              </div>

              <div>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <div className="section-title" style={{ marginBottom: 0 }}>
                    События ({allSelected ? 'все' : events.size})
                  </div>
                  <Button
                    disabled={events.size === 0}
                    onClick={() => form.setValue('events', [], { shouldValidate: true, shouldDirty: true })}
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
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <Button disabled={saving} type="submit">
                  <Save size={14} /> {saving ? 'Сохранение…' : 'Сохранить'}
                </Button>
              </div>
            </form>
          </div>

          <div className="card">
            <div className="card-header">
              <span className="card-title">Маршруты ({routes.length})</span>
            </div>
            <p className="hint" style={{ marginBottom: '0.5rem' }}>Клик по строке загружает весь набор этого URL в форму.</p>
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
                      <tr
                        key={r.route_id}
                        className={r.target_url === groupUrl ? 'row-highlight' : undefined}
                        onClick={() => applyGroup(routes, r.target_url)}
                        style={{ cursor: 'pointer' }}
                      >
                        <td style={mono}>{r.route_id}</td>
                        <td style={mono}>{r.event_type}</td>
                        <td style={{ ...mono, wordBreak: 'break-all' }}>{r.target_url}</td>
                        <td style={mono}>{r.secret_masked || '—'}</td>
                        <td onClick={(e) => e.stopPropagation()}>
                          <input
                            aria-label={`Маршрут ${r.route_id} включён`}
                            checked={r.enabled}
                            onChange={() => void toggleRoute(r)}
                            type="checkbox"
                          />
                        </td>
                        <td onClick={(e) => e.stopPropagation()}>
                          <button
                            aria-label={`Удалить маршрут ${r.route_id}`}
                            className="btn btn-danger btn-sm btn-icon"
                            onClick={() => void deleteRoute(r)}
                            title="Удалить"
                            type="button"
                          >
                            <Trash2 aria-hidden size={13} />
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
              <select
                aria-label="Фильтр по статусу"
                className="select w-auto ml-auto"
                onChange={(e) => onStatusFilter(e.target.value)}
                value={statusFilter}
              >
                {STATUS_FILTERS.map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <DeliveryTable
              empty="Нет доставок"
              highlightId={highlightId}
              onRetry={(id) => void retryDelivery(id)}
              rows={deliveries}
            />
          </div>

          <div className="card">
            <div className="card-header">
              <span className="card-title">Очередь ошибок ({dlq.length})</span>
              <Button
                disabled={retryAllBusy || dlq.length === 0}
                onClick={() => void retryAllDlq()}
                size="sm"
                className="ml-auto shrink-0"
                type="button"
                variant="warn"
              >
                <RotateCcw size={13} /> {retryAllBusy ? 'Повторяю…' : 'Повторить все'}
              </Button>
            </div>
            <DeliveryTable
              empty="Очередь ошибок пуста"
              highlightId={highlightId}
              onRetry={(id) => void retryDelivery(id)}
              rows={dlq}
            />
          </div>
        </>
      )}

      <DangerConfirmDialog
        busy={dangerBusy || retryAllBusy}
        confirmLabel={danger?.kind === 'retry-all-dlq' ? 'Повторить' : 'Удалить'}
        confirmPhrase={danger?.kind === 'retry-all-dlq' ? 'ПОВТОРИТЬ' : 'УДАЛИТЬ'}
        description={
          danger?.kind === 'delete-route'
            ? `Удалить маршрут ${danger.route.route_id} (${danger.route.event_type})?`
            : danger?.kind === 'retry-all-dlq'
              ? `Повторить доставку всех ${dlq.length} записей из очереди ошибок?`
              : ''
        }
        onCancel={() => !(dangerBusy || retryAllBusy) && setDanger(null)}
        onConfirm={() => {
          if (danger?.kind === 'delete-route') void doDeleteRoute(danger.route)
          else if (danger?.kind === 'retry-all-dlq') void doRetryAllDlq()
        }}
        open={danger != null}
        title={danger?.kind === 'retry-all-dlq' ? 'Повторить очередь ошибок?' : 'Удалить маршрут?'}
      />
    </div>
  )
}
