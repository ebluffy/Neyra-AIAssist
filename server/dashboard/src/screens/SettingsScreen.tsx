import { useCallback, useEffect, useMemo, useState } from 'react'
import { KeyRound, Loader2, SlidersHorizontal, Sparkles } from 'lucide-react'
import { apiGet, apiPost, getStoredApiToken, setToken } from '../api'
import type { ApiEnvelope } from '../api'
import { Button } from '../components/ui/button'
import { InlineFeedback } from '../components/ui/inline-feedback'
import { PageHeader } from '../components/ui/page-header'

/** Leaf keys of CONFIG_RUNTIME_ALLOWLIST (server) — form fields only, not whole-role dicts. */
const FIELD_GROUPS: Array<{ title: string; keys: string[] }> = [
  {
    title: 'Talk model',
    keys: [
      'llm.talk_model.model',
      'llm.talk_model.provider',
      'llm.talk_model.temperature',
      'llm.talk_model.timeout_seconds',
      'llm.talk_model.reply_max_tokens',
      'llm.talk_model.lyrics_reply_max_tokens',
    ],
  },
  {
    title: 'Brain model',
    keys: [
      'llm.brain_model.model',
      'llm.brain_model.provider',
      'llm.brain_model.model_deep',
      'llm.brain_model.max_tokens',
      'llm.brain_model.temperature',
      'llm.brain_model.timeout_seconds',
    ],
  },
  {
    title: 'Memory model',
    keys: [
      'llm.memory_model.model',
      'llm.memory_model.provider',
      'llm.memory_model.max_tokens',
      'llm.memory_model.temperature',
    ],
  },
  {
    title: 'Vision model',
    keys: [
      'llm.vision_model.model',
      'llm.vision_model.provider',
      'llm.vision_model.max_tokens',
      'llm.vision_model.temperature',
      'llm.vision_model.timeout_seconds',
      'llm.vision_model.enabled',
      'llm.vision_model.use_brain_model_for_vision',
      'llm.vision_model.max_images_per_message',
      'llm.vision_model.max_image_bytes',
      'llm.vision_model.max_image_width',
      'llm.vision_model.max_image_height',
      'llm.vision_model.remember_last_image',
      'llm.vision_model.last_image_note_max_chars',
    ],
  },
  {
    title: 'Providers / legacy',
    keys: ['llm.providers.aihope.base_url', 'llm.providers.openrouter.base_url', 'llm.provider', 'llm.base_url'],
  },
  {
    title: 'Agent / memory / logging / health',
    keys: [
      'agent.fast_path.enabled',
      'memory.rag_write_mode',
      'logging.level',
      'health_monitor.enabled',
      'health_monitor.interval_seconds',
    ],
  },
]

const BOOL_KEYS = new Set([
  'llm.vision_model.enabled',
  'llm.vision_model.use_brain_model_for_vision',
  'llm.vision_model.remember_last_image',
  'agent.fast_path.enabled',
  'health_monitor.enabled',
])

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
  const [values, setValues] = useState<Record<string, string>>({})
  const [initial, setInitial] = useState<Record<string, string>>({})
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await apiGet<ApiEnvelope<{ values: Record<string, unknown> }>>('/v1/config/runtime')
      const next: Record<string, string> = {}
      for (const g of FIELD_GROUPS) {
        for (const k of g.keys) {
          next[k] = serialize(r.data.values?.[k])
        }
      }
      setValues(next)
      setInitial(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const dirty = useMemo(() => {
    return Object.keys(values).some((k) => values[k] !== initial[k])
  }, [values, initial])

  async function applyRuntime() {
    setError(null)
    setStatus('')
    setSaving(true)
    try {
      const updates: Record<string, unknown> = {}
      for (const [k, raw] of Object.entries(values)) {
        if (raw === initial[k]) continue
        updates[k] = parseValue(k, raw)
      }
      if (!Object.keys(updates).length) {
        setStatus('Нет изменений')
        return
      }
      await apiPost<ApiEnvelope<unknown>>('/v1/config/update', { updates })
      setStatus(`Обновлено: ${Object.keys(updates).join(', ')}`)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="page-content stack">
      <PageHeader title="Настройки" subtitle="Bearer override и runtime-конфиг (allowlist API)" />

      <div className="card">
        <div className="card-header">
          <KeyRound size={15} className="card-icon" />
          <span className="card-title">Bearer Token</span>
        </div>
        <div className="stack">
          <label className="label">
            <span className="label-text">Токен API (localStorage)</span>
            <input
              autoComplete="off"
              className="input input-mono"
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder="пусто = только session после входа"
              type="password"
              value={token}
            />
          </label>
          <p style={{ fontSize: '0.75rem', color: 'var(--muted)', lineHeight: 1.45 }}>
            Session после gate-login — в sessionStorage. Сюда — отдельный <code>API_TOKEN</code> для Discord/MCP.
          </p>
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
        {loading ? (
          <p style={{ color: 'var(--muted)' }}>Загрузка…</p>
        ) : (
          <div className="stack">
            {FIELD_GROUPS.map((g) => (
              <div key={g.title} className="settings-group">
                <p className="settings-group-title">{g.title}</p>
                <div className="grid-2">
                  {g.keys.map((key) => (
                    <label key={key} className="label">
                      <span className="label-text" style={{ fontFamily: 'var(--mono)', fontSize: '0.72rem' }}>
                        {key}
                      </span>
                      {BOOL_KEYS.has(key) ? (
                        <select
                          className="input input-mono"
                          onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
                          value={values[key] || 'false'}
                        >
                          <option value="true">true</option>
                          <option value="false">false</option>
                        </select>
                      ) : (
                        <input
                          className="input input-mono"
                          onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
                          value={values[key] ?? ''}
                        />
                      )}
                    </label>
                  ))}
                </div>
              </div>
            ))}
            <div className="row">
              <Button disabled={saving || !dirty} onClick={() => void applyRuntime()} type="button">
                {saving ? <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} /> : <Sparkles size={15} />}
                Применить изменения
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
