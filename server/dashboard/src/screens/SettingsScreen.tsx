import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { KeyRound, Loader2, Palette, SlidersHorizontal, Sparkles } from 'lucide-react'
import { useBlocker } from 'react-router-dom'
import { apiGet, apiPost, clearSessionToken, setSessionToken } from '../api'
import type { ApiEnvelope } from '../api'
import { Button } from '../components/ui/button'
import { DangerConfirmDialog } from '../components/ui/danger-confirm-dialog'
import { InlineFeedback } from '../components/ui/inline-feedback'
import { PageHeader } from '../components/ui/page-header'
import { Skeleton } from '../components/ui/skeleton'
import { pluralRu } from '../lib/plural-ru'
import { setThemePreference, useThemePreference, type ThemePreference } from '../lib/theme'
import { getDensity, setDensity, type Density } from '../lib/ui-prefs'

type FieldDef = { key: string; label: string; kind?: 'text' | 'bool' | 'provider' }

const TABS: Array<{ id: string; title: string; fields: FieldDef[] }> = [
  {
    id: 'talk',
    title: 'Речь',
    fields: [
      { key: 'llm.talk_model.model', label: 'Модель речи' },
      { key: 'llm.talk_model.provider', label: 'Провайдер', kind: 'provider' },
      { key: 'llm.talk_model.temperature', label: 'Температура' },
      { key: 'llm.talk_model.timeout_seconds', label: 'Таймаут (с)' },
      { key: 'llm.talk_model.reply_max_tokens', label: 'Макс. токенов ответа' },
      { key: 'llm.talk_model.lyrics_reply_max_tokens', label: 'Макс. токенов lyrics' },
    ],
  },
  {
    id: 'brain',
    title: 'Мозг',
    fields: [
      { key: 'llm.brain_model.model', label: 'Модель мозга' },
      { key: 'llm.brain_model.provider', label: 'Провайдер', kind: 'provider' },
      { key: 'llm.brain_model.model_deep', label: 'Глубокая модель' },
      { key: 'llm.brain_model.max_tokens', label: 'Макс. токенов' },
      { key: 'llm.brain_model.temperature', label: 'Температура' },
      { key: 'llm.brain_model.timeout_seconds', label: 'Таймаут (с)' },
    ],
  },
  {
    id: 'memory',
    title: 'Память',
    fields: [
      { key: 'llm.memory_model.model', label: 'Модель памяти' },
      { key: 'llm.memory_model.provider', label: 'Провайдер', kind: 'provider' },
      { key: 'llm.memory_model.max_tokens', label: 'Макс. токенов' },
      { key: 'llm.memory_model.temperature', label: 'Температура' },
      { key: 'memory.rag_write_mode', label: 'Режим записи RAG' },
    ],
  },
  {
    id: 'vision',
    title: 'Зрение',
    fields: [
      { key: 'llm.vision_model.model', label: 'Модель зрения' },
      { key: 'llm.vision_model.provider', label: 'Провайдер', kind: 'provider' },
      { key: 'llm.vision_model.enabled', label: 'Включено' },
      { key: 'llm.vision_model.use_brain_model_for_vision', label: 'Использовать модель мозга для зрения' },
      { key: 'llm.vision_model.max_tokens', label: 'Макс. токенов' },
      { key: 'llm.vision_model.temperature', label: 'Температура' },
      { key: 'llm.vision_model.timeout_seconds', label: 'Таймаут (с)' },
      { key: 'llm.vision_model.max_images_per_message', label: 'Макс. изображений' },
      { key: 'llm.vision_model.max_image_bytes', label: 'Макс. байт изображения' },
      { key: 'llm.vision_model.max_image_width', label: 'Макс. ширина' },
      { key: 'llm.vision_model.max_image_height', label: 'Макс. высота' },
      { key: 'llm.vision_model.remember_last_image', label: 'Запоминать последнее изображение' },
      { key: 'llm.vision_model.last_image_note_max_chars', label: 'Макс. символов заметки' },
    ],
  },
  {
    id: 'providers',
    title: 'Провайдеры',
    fields: [
      { key: 'llm.providers.openrouter.base_url', label: 'Базовый URL OpenRouter' },
      { key: 'llm.providers.aihope.base_url', label: 'Базовый URL AIHope' },
      { key: 'llm.provider', label: 'Провайдер по умолчанию', kind: 'provider' },
    ],
  },
  {
    id: 'system',
    title: 'Система',
    fields: [
      { key: 'agent.fast_path.enabled', label: 'Быстрый путь агента' },
      { key: 'logging.level', label: 'Уровень логов' },
      { key: 'health_monitor.enabled', label: 'Монитор здоровья' },
      { key: 'health_monitor.interval_seconds', label: 'Интервал проверки (с)' },
    ],
  },
]

const BOOL_KEYS = new Set(TABS.flatMap((t) => t.fields.filter((f) => f.key.endsWith('.enabled') || f.key.includes('use_brain') || f.key.includes('remember_')).map((f) => f.key)).concat([
  'llm.vision_model.enabled',
  'llm.vision_model.use_brain_model_for_vision',
  'llm.vision_model.remember_last_image',
  'agent.fast_path.enabled',
  'health_monitor.enabled',
]))

const NUMBER_KEYS = new Set([
  'llm.talk_model.temperature',
  'llm.talk_model.timeout_seconds',
  'llm.talk_model.reply_max_tokens',
  'llm.talk_model.lyrics_reply_max_tokens',
  'llm.brain_model.max_tokens',
  'llm.brain_model.temperature',
  'llm.brain_model.timeout_seconds',
  'llm.memory_model.max_tokens',
  'llm.memory_model.temperature',
  'llm.vision_model.max_tokens',
  'llm.vision_model.temperature',
  'llm.vision_model.timeout_seconds',
  'llm.vision_model.max_images_per_message',
  'llm.vision_model.max_image_bytes',
  'llm.vision_model.max_image_width',
  'llm.vision_model.max_image_height',
  'llm.vision_model.last_image_note_max_chars',
  'health_monitor.interval_seconds',
])

/** Fields that apply only after soft restart (hot-reload does not cover them). */
const RESTART_KEYS = new Set([
  'logging.level',
  'health_monitor.enabled',
  'health_monitor.interval_seconds',
  'agent.fast_path.enabled',
])

export async function rotateAccessKey(currentKey: string, newKey: string): Promise<string> {
  const ctrl = new AbortController()
  const timer = window.setTimeout(() => ctrl.abort(), 30_000)
  let r: Response
  try {
    r = await fetch('/v1/dashboard/auth/rotate', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_key: currentKey, new_key: newKey }),
      signal: ctrl.signal,
    })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new Error('Таймаут запроса смены ключа')
    }
    throw e
  } finally {
    window.clearTimeout(timer)
  }
  const text = await r.text()
  const trimmed = text.trimStart()
  if (trimmed.startsWith('<') || trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<!doctype')) {
    throw new Error(`Сервер недоступен (HTTP ${r.status || '—'}). Попробуй позже.`)
  }
  let j: { ok?: boolean; data?: { session_token?: string }; error?: { message?: string } }
  try {
    j = JSON.parse(text) as typeof j
  } catch {
    throw new Error(`Не удалось разобрать ответ API (HTTP ${r.status})`)
  }
  if (!r.ok || j.ok === false) {
    throw new Error(j.error?.message || `HTTP ${r.status}`)
  }
  const session = j.data?.session_token?.trim()
  if (!session) throw new Error('Сервер не выдал session_token')
  return session
}

function serialize(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  return String(v)
}

function parseValue(key: string, raw: string): unknown {
  const t = raw.trim()
  if (BOOL_KEYS.has(key)) return t === 'true' || t === '1' || t === 'yes'
  if (NUMBER_KEYS.has(key)) {
    const n = Number(t)
    if (!Number.isFinite(n)) throw new Error(`Число ожидается для ${key}`)
    return n
  }
  return t
}

export function SettingsScreen() {
  const [tab, setTab] = useState(TABS[0].id)
  const [values, setValues] = useState<Record<string, string>>({})
  const [initial, setInitial] = useState<Record<string, string>>({})
  const [providers, setProviders] = useState<string[]>([])
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [softOpen, setSoftOpen] = useState(false)
  const [softTitle, setSoftTitle] = useState('')
  const [softDescription, setSoftDescription] = useState('')
  const softResolveRef = useRef<((ok: boolean) => void) | null>(null)
  const [currentKey, setCurrentKey] = useState('')
  const [newKey, setNewKey] = useState('')
  const [newKey2, setNewKey2] = useState('')
  const [accessBusy, setAccessBusy] = useState(false)
  const [logoutAllOpen, setLogoutAllOpen] = useState(false)
  const themePref = useThemePreference()
  const [density, setDensityState] = useState<Density>(() => getDensity())

  function softConfirm(title: string, description: string): Promise<boolean> {
    setSoftTitle(title)
    setSoftDescription(description)
    setSoftOpen(true)
    return new Promise((resolve) => {
      softResolveRef.current = resolve
    })
  }

  function finishSoft(ok: boolean) {
    setSoftOpen(false)
    softResolveRef.current?.(ok)
    softResolveRef.current = null
  }

  const allKeys = useMemo(() => TABS.flatMap((t) => t.fields.map((f) => f.key)), [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await apiGet<ApiEnvelope<{ values: Record<string, unknown>; providers?: string[] }>>(
        '/v1/config/runtime',
      )
      const next: Record<string, string> = {}
      for (const k of allKeys) next[k] = serialize(r.data.values?.[k])
      setValues(next)
      setInitial(next)
      const list = Array.isArray(r.data.providers) ? r.data.providers.map(String).filter(Boolean) : []
      setProviders(list.length ? list : ['aihope', 'openrouter'])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [allKeys])

  useEffect(() => {
    void load()
  }, [load])

  const active = TABS.find((t) => t.id === tab) ?? TABS[0]
  const dirtyKeys = useMemo(
    () => active.fields.map((f) => f.key).filter((k) => values[k] !== initial[k]),
    [active, values, initial],
  )
  const allDirtyKeys = useMemo(
    () => allKeys.filter((k) => values[k] !== initial[k]),
    [allKeys, values, initial],
  )
  const anyDirty = allDirtyKeys.length > 0

  useEffect(() => {
    if (!anyDirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [anyDirty])

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      anyDirty && currentLocation.pathname !== nextLocation.pathname,
  )
  const leaveAskInFlight = useRef(false)

  useEffect(() => {
    if (blocker.state !== 'blocked' || leaveAskInFlight.current) return
    leaveAskInFlight.current = true
    void softConfirm(
      'Несохранённые изменения',
      'Есть несохранённые изменения в Настройках. Уйти без применения?',
    ).then((ok) => {
      leaveAskInFlight.current = false
      if (ok) blocker.proceed?.()
      else blocker.reset?.()
    })
  }, [blocker])

  async function selectTab(id: string) {
    if (id === tab) return
    if (dirtyKeys.length > 0) {
      if (
        !(await softConfirm(
          'Несохранённые изменения',
          'На этой вкладке есть несохранённые изменения. Уйти без применения?',
        ))
      ) {
        return
      }
    }
    setTab(id)
    setStatus('')
    setError(null)
  }

  const providerOptions = useMemo(() => {
    const cur = providers.slice()
    for (const f of TABS.flatMap((t) => t.fields)) {
      if (f.kind !== 'provider') continue
      const v = (values[f.key] || '').trim()
      if (v && !cur.includes(v)) cur.push(v)
    }
    return cur
  }, [providers, values])

  async function applyRuntime(keys: string[]) {
    setError(null)
    setStatus('')
    setSaving(true)
    try {
      const updates: Record<string, unknown> = {}
      for (const k of keys) updates[k] = parseValue(k, values[k] ?? '')
      if (!Object.keys(updates).length) {
        setStatus('Нет изменений')
        return
      }
      await apiPost<ApiEnvelope<unknown>>('/v1/config/update', { updates })
      const needRestart = keys.some((k) => RESTART_KEYS.has(k))
      setStatus(
        needRestart
          ? `Сохранено ${Object.keys(updates).length} ключ(ей). Часть полей требует мягкого рестарта.`
          : `Сохранено на диск и применено: ${Object.keys(updates).length} ключ(ей). LLM пересобран при смене моделей/провайдера.`,
      )
      await load()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      if (/диск|disk|llm_rebind|пересобран/i.test(msg)) {
        setStatus('На диске могло сохраниться — при ошибке LLM сделай мягкий рестарт или повтори «Применить».')
      }
    } finally {
      setSaving(false)
    }
  }

  function discardDirty() {
    setValues({ ...initial })
    setStatus('Изменения отменены')
    setError(null)
  }

  function renderField(f: FieldDef) {
    const commonLabel = (
      <span className="label-text">
        {f.label}{' '}
        <span style={{ fontFamily: 'var(--mono)', fontSize: '0.7rem', color: 'var(--muted)', fontWeight: 400 }}>
          ({f.key})
        </span>
        {RESTART_KEYS.has(f.key) ? (
          <span className="badge badge-warn" style={{ marginLeft: 6, fontSize: '0.7rem' }}>
            нужен перезапуск
          </span>
        ) : null}
      </span>
    )
    if (BOOL_KEYS.has(f.key) || f.kind === 'bool') {
      return (
        <label key={f.key} className="label">
          {commonLabel}
          <select
            className="select input-mono"
            onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            value={values[f.key] || 'false'}
          >
            <option value="true">да</option>
            <option value="false">нет</option>
          </select>
        </label>
      )
    }
    if (f.kind === 'provider') {
      const current = values[f.key] || ''
      return (
        <label key={f.key} className="label">
          {commonLabel}
          <select
            className="select input-mono"
            onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            value={current}
          >
            {!current && <option value="">— выбери —</option>}
            {providerOptions.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
      )
    }
    return (
      <label key={f.key} className="label">
        {commonLabel}
        <input
          className="input input-mono"
          onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
          value={values[f.key] ?? ''}
        />
      </label>
    )
  }

  return (
    <div className="page-content stack settings-page">
      <PageHeader title="Настройки" subtitle="Доступ, внешний вид и runtime-конфиг" />

      <nav aria-label="Разделы настроек" className="settings-anchors">
        <a className="settings-anchor" href="#settings-access">
          Доступ
        </a>
        <a className="settings-anchor" href="#settings-appearance">
          Внешний вид
        </a>
        <a className="settings-anchor" href="#settings-runtime">
          Конфиг
        </a>
      </nav>

      <div className="card" id="settings-access">
        <div className="card-header">
          <KeyRound size={15} className="card-icon card-icon-pink" />
          <span className="card-title">Доступ к дашборду</span>
        </div>
        <p className="hint" style={{ marginBottom: '0.75rem' }}>
          Смена ключа входа отзывает все сессии. Новый ключ ≥ 32 символов. После rotate сессия этой вкладки
          обновится автоматически.
        </p>
        <div className="stack-sm">
          <label className="label">
            <span className="label-text">Текущий ключ</span>
            <input
              autoComplete="current-password"
              className="input input-mono"
              onChange={(e) => setCurrentKey(e.target.value)}
              type="password"
              value={currentKey}
            />
          </label>
          <label className="label">
            <span className="label-text">Новый ключ</span>
            <input
              autoComplete="new-password"
              className="input input-mono"
              onChange={(e) => setNewKey(e.target.value)}
              type="password"
              value={newKey}
            />
          </label>
          <label className="label">
            <span className="label-text">Повтор нового ключа</span>
            <input
              autoComplete="new-password"
              className="input input-mono"
              onChange={(e) => setNewKey2(e.target.value)}
              type="password"
              value={newKey2}
            />
          </label>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <Button
              disabled={accessBusy}
              onClick={() => {
                void (async () => {
                  setError(null)
                  setStatus('')
                  if (newKey !== newKey2) {
                    setError('Новый ключ и повтор не совпадают')
                    return
                  }
                  if (newKey.trim().length < 32) {
                    setError('Новый ключ должен быть не короче 32 символов')
                    return
                  }
                  setAccessBusy(true)
                  try {
                    const session = await rotateAccessKey(currentKey, newKey)
                    setSessionToken(session)
                    setCurrentKey('')
                    setNewKey('')
                    setNewKey2('')
                    setStatus('Ключ доступа сменён. Все старые сессии отозваны.')
                  } catch (e) {
                    setError(e instanceof Error ? e.message : String(e))
                  } finally {
                    setAccessBusy(false)
                  }
                })()
              }}
              type="button"
            >
              {accessBusy ? '…' : 'Сменить ключ доступа'}
            </Button>
            <Button
              disabled={accessBusy}
              onClick={() => setLogoutAllOpen(true)}
              type="button"
              variant="warn"
            >
              Выйти на всех устройствах
            </Button>
          </div>
        </div>
      </div>

      <div className="card" id="settings-appearance">
        <div className="card-header">
          <Palette size={15} className="card-icon card-icon-cyan" />
          <span className="card-title">Внешний вид</span>
        </div>
        <div className="grid-2">
          <label className="label">
            <span className="label-text">Тема</span>
            <select
              className="select"
              onChange={(e) => {
                setThemePreference(e.target.value as ThemePreference)
              }}
              value={themePref}
            >
              <option value="system">Системная</option>
              <option value="dark">Тёмная</option>
              <option value="light">Светлая</option>
            </select>
          </label>
          <label className="label">
            <span className="label-text">Плотность</span>
            <select
              className="select"
              onChange={(e) => {
                const d = e.target.value as Density
                setDensityState(d)
                setDensity(d)
              }}
              value={density}
            >
              <option value="compact">Компактная</option>
              <option value="comfortable">Свободная</option>
            </select>
          </label>
        </div>
      </div>

      <div className="card" id="settings-runtime">
        <div className="card-header">
          <SlidersHorizontal size={15} className="card-icon card-icon-pink" />
          <span className="card-title">Runtime-конфиг</span>
        </div>
        <p style={{ fontSize: '0.8rem', color: 'var(--muted)', margin: '0 0 0.65rem' }}>
          «Применить» пишет в <span style={{ fontFamily: 'var(--mono)' }}>config/*.yaml</span> и сразу пересобирает LLM-клиенты
          (без мягкого перезапуска). Если LLM не пересобрался — на диске уже может быть новое значение; мягкий рестарт подхватит его.
        </p>
        <div className="tabs-row" role="tablist" aria-label="Разделы конфига">
          {TABS.map((t) => (
            <Button
              key={t.id}
              aria-selected={tab === t.id}
              onClick={() => void selectTab(t.id)}
              role="tab"
              size="sm"
              type="button"
              variant={tab === t.id ? 'default' : 'secondary'}
            >
              {t.title}
            </Button>
          ))}
        </div>
        {loading ? (
          <div className="stack" style={{ marginTop: '0.85rem' }}>
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : (
          <div className="stack" style={{ marginTop: '0.85rem' }}>
            <div className="grid-2">{active.fields.map((f) => renderField(f))}</div>
            <div className="row">
              <Button
                disabled={saving || dirtyKeys.length === 0}
                onClick={() => void applyRuntime(dirtyKeys)}
                type="button"
              >
                {saving ? <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} /> : <Sparkles size={15} />}
                Применить вкладку
              </Button>
              <Button disabled={loading} onClick={() => void load()} type="button" variant="secondary">
                Сбросить к серверу
              </Button>
            </div>
          </div>
        )}
        {error && <InlineFeedback tone="error">{error}</InlineFeedback>}
        {status && <InlineFeedback tone="success">{status}</InlineFeedback>}
      </div>

      {anyDirty ? (
        <div aria-live="polite" className="settings-dirty-bar" role="status">
          <span>
            Изменено {allDirtyKeys.length}{' '}
            {pluralRu(allDirtyKeys.length, 'поле', 'поля', 'полей')}
          </span>
          <div className="row">
            <Button disabled={saving} onClick={discardDirty} size="sm" type="button" variant="secondary">
              Отменить
            </Button>
            <Button disabled={saving} onClick={() => void applyRuntime(allDirtyKeys)} size="sm" type="button">
              {saving ? '…' : 'Сохранить'}
            </Button>
          </div>
        </div>
      ) : null}

      <DangerConfirmDialog
        busy={false}
        confirmLabel="Уйти"
        confirmPhrase=""
        description={softDescription}
        onCancel={() => finishSoft(false)}
        onConfirm={() => finishSoft(true)}
        open={softOpen}
        title={softTitle}
      />

      <DangerConfirmDialog
        busy={accessBusy}
        confirmLabel="Выйти везде"
        confirmPhrase="ВЫЙТИ"
        description="Все session-токены дашборда будут отозваны, включая эту вкладку. Потребуется войти снова."
        onCancel={() => !accessBusy && setLogoutAllOpen(false)}
        onConfirm={() => {
          void (async () => {
            setAccessBusy(true)
            setError(null)
            try {
              await apiPost<ApiEnvelope<{ revoked?: number }>>('/v1/dashboard/auth/logout-all', {})
              clearSessionToken()
              setLogoutAllOpen(false)
              setStatus('Все сессии отозваны. Обнови страницу и войди снова.')
              window.location.assign('/')
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e))
              setLogoutAllOpen(false)
            } finally {
              setAccessBusy(false)
            }
          })()
        }}
        open={logoutAllOpen}
        title="Выйти на всех устройствах?"
      />
    </div>
  )
}
