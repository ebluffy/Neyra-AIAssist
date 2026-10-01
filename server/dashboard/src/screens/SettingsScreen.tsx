import { useCallback, useEffect, useMemo, useState } from 'react'
import { KeyRound, Loader2, SlidersHorizontal, Sparkles } from 'lucide-react'
import { apiGet, apiPost, getStoredApiToken, setToken } from '../api'
import type { ApiEnvelope } from '../api'
import { Button } from '../components/ui/button'
import { InlineFeedback } from '../components/ui/inline-feedback'
import { PageHeader } from '../components/ui/page-header'

type FieldDef = { key: string; label: string }

const TABS: Array<{ id: string; title: string; fields: FieldDef[] }> = [
  {
    id: 'talk',
    title: 'Talk',
    fields: [
      { key: 'llm.talk_model.model', label: 'Модель речи' },
      { key: 'llm.talk_model.provider', label: 'Провайдер' },
      { key: 'llm.talk_model.temperature', label: 'Temperature' },
      { key: 'llm.talk_model.timeout_seconds', label: 'Таймаут (с)' },
      { key: 'llm.talk_model.reply_max_tokens', label: 'Max tokens ответа' },
      { key: 'llm.talk_model.lyrics_reply_max_tokens', label: 'Max tokens lyrics' },
    ],
  },
  {
    id: 'brain',
    title: 'Brain',
    fields: [
      { key: 'llm.brain_model.model', label: 'Модель мозга' },
      { key: 'llm.brain_model.provider', label: 'Провайдер' },
      { key: 'llm.brain_model.model_deep', label: 'Deep-модель' },
      { key: 'llm.brain_model.max_tokens', label: 'Max tokens' },
      { key: 'llm.brain_model.temperature', label: 'Temperature' },
      { key: 'llm.brain_model.timeout_seconds', label: 'Таймаут (с)' },
    ],
  },
  {
    id: 'memory',
    title: 'Memory',
    fields: [
      { key: 'llm.memory_model.model', label: 'Модель памяти' },
      { key: 'llm.memory_model.provider', label: 'Провайдер' },
      { key: 'llm.memory_model.max_tokens', label: 'Max tokens' },
      { key: 'llm.memory_model.temperature', label: 'Temperature' },
      { key: 'memory.rag_write_mode', label: 'Режим записи RAG' },
    ],
  },
  {
    id: 'vision',
    title: 'Vision',
    fields: [
      { key: 'llm.vision_model.model', label: 'Модель зрения' },
      { key: 'llm.vision_model.provider', label: 'Провайдер' },
      { key: 'llm.vision_model.enabled', label: 'Включено' },
      { key: 'llm.vision_model.use_brain_model_for_vision', label: 'Использовать brain для vision' },
      { key: 'llm.vision_model.max_tokens', label: 'Max tokens' },
      { key: 'llm.vision_model.temperature', label: 'Temperature' },
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
    title: 'Providers',
    fields: [
      { key: 'llm.providers.openrouter.base_url', label: 'OpenRouter base URL' },
      { key: 'llm.providers.aihope.base_url', label: 'AIHope base URL' },
      { key: 'llm.provider', label: 'Провайдер по умолчанию' },
      { key: 'llm.base_url', label: 'Legacy base URL' },
    ],
  },
  {
    id: 'system',
    title: 'Система',
    fields: [
      { key: 'agent.fast_path.enabled', label: 'Fast path агента' },
      { key: 'logging.level', label: 'Уровень логов' },
      { key: 'health_monitor.enabled', label: 'Health monitor' },
      { key: 'health_monitor.interval_seconds', label: 'Интервал health (с)' },
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
  const [token, setTokenInput] = useState(getStoredApiToken())
  const [tab, setTab] = useState(TABS[0].id)
  const [values, setValues] = useState<Record<string, string>>({})
  const [initial, setInitial] = useState<Record<string, string>>({})
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  const allKeys = useMemo(() => TABS.flatMap((t) => t.fields.map((f) => f.key)), [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await apiGet<ApiEnvelope<{ values: Record<string, unknown> }>>('/v1/config/runtime')
      const next: Record<string, string> = {}
      for (const k of allKeys) next[k] = serialize(r.data.values?.[k])
      setValues(next)
      setInitial(next)
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

  async function applyRuntime() {
    setError(null)
    setStatus('')
    setSaving(true)
    try {
      const updates: Record<string, unknown> = {}
      for (const k of dirtyKeys) updates[k] = parseValue(k, values[k] ?? '')
      if (!Object.keys(updates).length) {
        setStatus('Нет изменений в этой вкладке')
        return
      }
      await apiPost<ApiEnvelope<unknown>>('/v1/config/update', { updates })
      setStatus(`Обновлено: ${Object.keys(updates).length} ключ(ей)`)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="page-content stack">
      <PageHeader title="Настройки" subtitle="Bearer и runtime-конфиг по разделам" />

      <div className="card">
        <div className="card-header">
          <KeyRound size={15} className="card-icon" />
          <span className="card-title">Bearer Token</span>
        </div>
        <label className="label">
          <span className="label-text">Токен API (localStorage)</span>
          <input
            autoComplete="off"
            className="input input-mono"
            onChange={(e) => setTokenInput(e.target.value)}
            type="password"
            value={token}
          />
        </label>
        <div style={{ marginTop: '0.75rem' }}>
          <Button
            onClick={() => {
              setToken(token)
              setStatus('Токен сохранён')
            }}
            type="button"
          >
            Сохранить токен
          </Button>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <SlidersHorizontal size={15} className="card-icon card-icon-pink" />
          <span className="card-title">Runtime config</span>
        </div>
        <div className="tabs-row" role="tablist" aria-label="Разделы конфига">
          {TABS.map((t) => (
            <Button key={t.id} onClick={() => setTab(t.id)} size="sm" type="button" variant={tab === t.id ? 'default' : 'secondary'}>
              {t.title}
            </Button>
          ))}
        </div>
        {loading ? (
          <p style={{ color: 'var(--muted)' }}>Загрузка…</p>
        ) : (
          <div className="stack" style={{ marginTop: '0.85rem' }}>
            <div className="grid-2">
              {active.fields.map((f) => (
                <label key={f.key} className="label">
                  <span className="label-text">
                    {f.label}{' '}
                    <span style={{ fontFamily: 'var(--mono)', fontSize: '0.7rem', color: 'var(--muted)', fontWeight: 400 }}>
                      ({f.key})
                    </span>
                  </span>
                  {BOOL_KEYS.has(f.key) ? (
                    <select
                      className="input input-mono"
                      onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                      value={values[f.key] || 'false'}
                    >
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </select>
                  ) : (
                    <input
                      className="input input-mono"
                      onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                      value={values[f.key] ?? ''}
                    />
                  )}
                </label>
              ))}
            </div>
            <div className="row">
              <Button disabled={saving || dirtyKeys.length === 0} onClick={() => void applyRuntime()} type="button">
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
    </div>
  )
}
