import { useState } from 'react'
import { KeyRound, Loader2, SlidersHorizontal, Sparkles } from 'lucide-react'
import { apiPost, getToken, setToken } from '../api'
import { Button } from '../components/ui/button'
import { InlineFeedback } from '../components/ui/inline-feedback'
import type { ApiEnvelope } from '../types'

export function SettingsPage() {
  const [token, setTokenInput] = useState(getToken())
  const [model, setModel] = useState('')
  const [temperature, setTemperature] = useState('0.8')
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function applyRuntime() {
    setError(null); setStatus('Применение...'); setLoading(true)
    try {
      await apiPost<ApiEnvelope<unknown>>('/v1/config/update', {
        updates: {
          'openrouter.talk_model.model': model,
          'openrouter.talk_model.temperature': Number(temperature),
        },
      })
      setStatus('Настройки применены')
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setLoading(false) }
  }

  return (
    <div className="page-content stack">
      <div className="page-header">
        <h1 className="page-title">Настройки</h1>
        <p className="page-sub">Токен авторизации и runtime конфиг модели</p>
      </div>

      <div className="grid-2">
        {/* Token card */}
        <div className="card">
          <div className="card-header">
            <KeyRound size={15} className="card-icon" />
            <span className="card-title">Bearer Token</span>
          </div>
          <div className="stack">
            <label className="label">
              <span className="label-text">Токен API (хранится в браузере)</span>
              <input
                autoComplete="off"
                className="input input-mono"
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder="опционально"
                type="password"
                value={token}
              />
            </label>
            <div>
              <Button
                onClick={() => { setToken(token); setStatus('Токен сохранён') }}
                type="button"
              >
                Сохранить токен
              </Button>
            </div>
          </div>
        </div>

        {/* Runtime config */}
        <div className="card">
          <div className="card-header">
            <SlidersHorizontal size={15} className="card-icon card-icon-pink" />
            <span className="card-title">Runtime config</span>
          </div>
          <div className="stack">
            <label className="label">
              <span className="label-text">openrouter.talk_model.model</span>
              <input
                className="input"
                onChange={(e) => setModel(e.target.value)}
                placeholder="например qwen/qwen3-235b-a22b-2507"
                value={model}
              />
            </label>
            <label className="label">
              <span className="label-text">openrouter.talk_model.temperature</span>
              <input
                className="input input-mono"
                onChange={(e) => setTemperature(e.target.value)}
                value={temperature}
              />
              <span style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>Диапазон: 0.0 – 1.5</span>
            </label>
            <div>
              <Button disabled={loading} onClick={() => void applyRuntime()} type="button">
                {loading ? <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} /> : <Sparkles size={15} />}
                Применить
              </Button>
            </div>
            {error  && <InlineFeedback tone="error">{error}</InlineFeedback>}
            {status && <InlineFeedback tone="success">{status}</InlineFeedback>}
            {!error && !status && (
              <p style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>Измени параметры и нажми «Применить».</p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
