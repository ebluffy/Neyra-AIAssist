import { useCallback, useEffect, useState } from 'react'
import { FileCode2, Play, RefreshCw, Settings2, ToggleLeft, ToggleRight } from 'lucide-react'
import { apiGet, apiPatch, apiPost, apiPut } from '../api'
import { Button } from '../components/ui/button'
import { EmptyState } from '../components/ui/empty-state'
import { InlineFeedback } from '../components/ui/inline-feedback'
import { Skeleton } from '../components/ui/skeleton'
import type { ApiEnvelope, PluginRow } from '../types'

type PluginDetails = { plugin: PluginRow; config: Record<string, unknown> }

export function PluginsPage() {
  const [plugins, setPlugins] = useState<PluginRow[]>([])
  const [selected, setSelected] = useState<string>('')
  const [details, setDetails] = useState<PluginDetails | null>(null)
  const [configText, setConfigText] = useState('{}')
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loadingPlugins, setLoadingPlugins] = useState(false)
  const [loadingDetails, setLoadingDetails] = useState(false)

  const loadPlugins = useCallback(async () => {
    setLoadingPlugins(true)
    const r = await apiGet<ApiEnvelope<{ plugins: PluginRow[] }>>('/v1/plugins')
    setPlugins(r.data.plugins ?? [])
    if (!selected && r.data.plugins?.length) setSelected(r.data.plugins[0].id)
    setLoadingPlugins(false)
  }, [selected])

  const loadDetails = useCallback(async (id: string) => {
    setLoadingDetails(true)
    const r = await apiGet<ApiEnvelope<PluginDetails>>(`/v1/plugins/${id}`)
    setDetails(r.data)
    setConfigText(JSON.stringify(r.data.config ?? {}, null, 2))
    setLoadingDetails(false)
  }, [])

  useEffect(() => { void loadPlugins() }, [loadPlugins])
  useEffect(() => { if (selected) void loadDetails(selected) }, [selected, loadDetails])

  async function togglePlugin(enabled: boolean) {
    if (!selected) return
    setError(null); setStatus('Применение...')
    try {
      const r = await apiPatch<ApiEnvelope<{ operation_id: string }>>(`/v1/plugins/${selected}`, { enabled })
      setStatus(`Готово: ${r.data.operation_id}`)
      await loadPlugins(); await loadDetails(selected)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function saveConfig() {
    if (!selected) return
    setError(null); setStatus('Сохраняю...')
    try {
      const parsed = JSON.parse(configText) as Record<string, unknown>
      await apiPut<ApiEnvelope<{ operation_id: string }>>(`/v1/plugins/${selected}/config`, { config: parsed })
      setStatus('Config сохранён'); await loadDetails(selected)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function invokePlugin() {
    if (!selected) return
    setError(null); setStatus('Invoke...')
    try {
      await apiPost<ApiEnvelope<unknown>>(`/v1/plugins/${selected}/invoke`, { payload: {} })
      setStatus('Invoke выполнен')
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  return (
    <div className="page-content stack">
      <div className="page-header">
        <h1 className="page-title">Плагины</h1>
        <p className="page-sub">Управление, конфиг и вызов плагинов</p>
      </div>

      <div style={{ display: 'grid', gap: '1rem', gridTemplateColumns: '260px 1fr' }}>
        {/* Plugin list */}
        <div className="card" style={{ height: 'fit-content' }}>
          <div className="card-header">
            <Settings2 size={15} className="card-icon" />
            <span className="card-title">Список</span>
          </div>
          <div className="stack-sm">
            {loadingPlugins && [1, 2, 3].map((i) => <Skeleton key={i} className="h-10" />)}
            {!loadingPlugins && plugins.map((p) => (
              <button
                key={p.id}
                className={`plugin-item${selected === p.id ? ' active' : ''}`}
                onClick={() => setSelected(p.id)}
                type="button"
              >
                <span style={{ fontFamily: 'var(--mono)', fontSize: '0.8rem' }}>{p.id}</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.75rem' }}>
                  <span className={`status-dot ${p.enabled ? 'status-dot-ok' : 'status-dot-idle'}`} />
                  {p.enabled ? 'on' : 'off'}
                </span>
              </button>
            ))}
            {!loadingPlugins && plugins.length === 0 && (
              <EmptyState icon={Settings2} title="Нет плагинов" description="Проверь /v1/plugins" />
            )}
          </div>
        </div>

        {/* Detail panel */}
        <div className="stack">
          {/* Controls */}
          <div className="card">
            <div className="card-header">
              <Settings2 size={15} className="card-icon card-icon-cyan" />
              <span className="card-title">Управление</span>
            </div>
            <div className="row">
              <button
                aria-label="toggle"
                className={`toggle-pill ${details?.plugin.enabled ? 'toggle-on' : 'toggle-off'}`}
                onClick={() => void togglePlugin(!Boolean(details?.plugin.enabled))}
                type="button"
              >
                {details?.plugin.enabled ? <ToggleRight size={18} /> : <ToggleLeft size={18} />}
                {details?.plugin.enabled ? 'Enabled' : 'Disabled'}
              </button>
              <Button onClick={() => void invokePlugin()} type="button" variant="secondary">
                <Play size={14} /> Invoke
              </Button>
              <Button onClick={() => selected && void loadDetails(selected)} type="button" variant="secondary">
                <RefreshCw size={14} /> Обновить
              </Button>
            </div>
            {status && <div style={{ marginTop: '0.65rem' }}><InlineFeedback tone="success">{status}</InlineFeedback></div>}
            {!status && <p style={{ marginTop: '0.65rem', fontSize: '0.8rem', color: 'var(--muted)' }}>Выбери плагин слева.</p>}
          </div>

          {/* State */}
          <div className="card">
            <div className="card-header">
              <FileCode2 size={15} className="card-icon" />
              <span className="card-title">Состояние</span>
            </div>
            {loadingDetails && <Skeleton className="h-24" />}
            <pre className="code-block">{details ? JSON.stringify(details.plugin, null, 2) : '—'}</pre>
          </div>

          {/* Config editor */}
          <div className="card">
            <div className="card-header">
              <FileCode2 size={15} className="card-icon card-icon-pink" />
              <span className="card-title">Конфиг плагина</span>
            </div>
            {error && <div style={{ marginBottom: '0.75rem' }}><InlineFeedback tone="error">{error}</InlineFeedback></div>}
            <textarea
              className="textarea"
              onChange={(e) => setConfigText(e.target.value)}
              style={{ minHeight: 200 }}
              value={configText}
            />
            <div className="row" style={{ marginTop: '0.75rem' }}>
              <Button onClick={() => void saveConfig()} type="button">Сохранить config</Button>
              <Button onClick={() => selected && void loadDetails(selected)} type="button" variant="secondary">
                Перезагрузить из файла
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
