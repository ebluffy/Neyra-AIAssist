import { useCallback, useEffect, useState } from 'react'
import { FileCode2, Play, RefreshCw, RotateCcw, Settings2, ToggleLeft, ToggleRight } from 'lucide-react'
import { apiGet, apiPatch, apiPost, apiPut } from '../api'
import type { ApiEnvelope, PluginRow } from '../api'
import { Button } from '../components/ui/button'
import { EmptyState } from '../components/ui/empty-state'
import { InlineFeedback } from '../components/ui/inline-feedback'
import { PageHeader } from '../components/ui/page-header'
import { Skeleton } from '../components/ui/skeleton'

type PluginDetails = { plugin: PluginRow; config: Record<string, unknown> }

export function ModulesScreen() {
  const [plugins, setPlugins] = useState<PluginRow[]>([])
  const [selected, setSelected] = useState('')
  const [details, setDetails] = useState<PluginDetails | null>(null)
  const [configText, setConfigText] = useState('{}')
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loadingPlugins, setLoadingPlugins] = useState(false)
  const [loadingDetails, setLoadingDetails] = useState(false)

  const loadPlugins = useCallback(async () => {
    setLoadingPlugins(true)
    try {
      const r = await apiGet<ApiEnvelope<{ plugins: PluginRow[] }>>('/v1/plugins')
      const list = r.data.plugins ?? []
      setPlugins(list)
      setSelected((prev) => {
        if (prev && list.some((p) => p.id === prev)) return prev
        return list[0]?.id ?? ''
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoadingPlugins(false)
    }
  }, [])

  const loadDetails = useCallback(async (id: string) => {
    setLoadingDetails(true)
    try {
      const r = await apiGet<ApiEnvelope<PluginDetails>>(`/v1/plugins/${id}`)
      setDetails(r.data)
      setConfigText(JSON.stringify(r.data.config ?? {}, null, 2))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoadingDetails(false)
    }
  }, [])

  useEffect(() => {
    void loadPlugins()
  }, [loadPlugins])
  useEffect(() => {
    if (selected) void loadDetails(selected)
  }, [selected, loadDetails])

  async function togglePlugin(enabled: boolean) {
    if (!selected) return
    setError(null)
    setStatus('Применение...')
    try {
      const r = await apiPatch<ApiEnvelope<{ operation_id: string }>>(`/v1/plugins/${selected}`, { enabled })
      setStatus(`Готово: ${r.data.operation_id}`)
      await loadPlugins()
      await loadDetails(selected)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function saveConfig() {
    if (!selected) return
    setError(null)
    setStatus('Сохраняю...')
    try {
      const parsed = JSON.parse(configText) as Record<string, unknown>
      await apiPut<ApiEnvelope<{ operation_id: string }>>(`/v1/plugins/${selected}/config`, { config: parsed })
      setStatus('Конфиг сохранён')
      await loadDetails(selected)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function invokePlugin() {
    if (!selected) return
    setError(null)
    setStatus('Вызов...')
    try {
      await apiPost<ApiEnvelope<unknown>>(`/v1/plugins/${selected}/invoke`, { payload: {} })
      setStatus('Вызов выполнен')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function reloadPlugin() {
    if (!selected) return
    setError(null)
    setStatus('Перезагрузка...')
    try {
      const r = await apiPost<ApiEnvelope<{ operation_id?: string }>>(`/v1/plugins/${selected}/reload`, {})
      setStatus(`Перезагрузка: ${r.data.operation_id ?? 'ок'}`)
      await loadPlugins()
      await loadDetails(selected)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function restartPlugin() {
    if (!selected) return
    if (!window.confirm(`Перезапустить модуль «${selected}»?`)) return
    setError(null)
    setStatus('Перезапуск...')
    try {
      const r = await apiPost<ApiEnvelope<{ operation_id?: string }>>(`/v1/plugins/${selected}/restart`, {})
      setStatus(`Перезапуск: ${r.data.operation_id ?? 'ок'}`)
      await loadPlugins()
      await loadDetails(selected)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="page-content stack">
      <PageHeader title="Модули" subtitle="Управление, конфиг, перезагрузка и вызов" />
      {error && <InlineFeedback tone="error">{error}</InlineFeedback>}

      <div className="split-modules">
        <div className="card" style={{ height: 'fit-content' }}>
          <div className="card-header">
            <Settings2 size={15} className="card-icon" />
            <span className="card-title">Список</span>
          </div>
          <div className="stack-sm">
            {loadingPlugins && [1, 2, 3].map((i) => <Skeleton key={i} className="h-10" />)}
            {!loadingPlugins &&
              plugins.map((p) => (
                <button
                  key={p.id}
                  className={`plugin-item${selected === p.id ? ' active' : ''}`}
                  onClick={() => setSelected(p.id)}
                  type="button"
                >
                  <span style={{ fontFamily: 'var(--mono)', fontSize: '0.8rem' }}>{p.id}</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.75rem' }}>
                    <span className={`status-dot ${p.enabled ? 'status-dot-ok' : 'status-dot-idle'}`} />
                    {p.enabled ? 'вкл.' : 'выкл.'}
                  </span>
                </button>
              ))}
            {!loadingPlugins && plugins.length === 0 && (
              <EmptyState icon={Settings2} title="Нет модулей" description="Проверь /v1/plugins" />
            )}
          </div>
        </div>

        <div className="stack">
          <div className="card">
            <div className="card-header">
              <Settings2 size={15} className="card-icon card-icon-cyan" />
              <span className="card-title">Управление</span>
            </div>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <button
                aria-label="включить или выключить модуль"
                className={`toggle-pill ${details?.plugin.enabled ? 'toggle-on' : 'toggle-off'}`}
                onClick={() => void togglePlugin(!Boolean(details?.plugin.enabled))}
                type="button"
              >
                {details?.plugin.enabled ? <ToggleRight size={18} /> : <ToggleLeft size={18} />}
                {details?.plugin.enabled ? 'Включен' : 'Выключен'}
              </button>
              <Button onClick={() => void invokePlugin()} type="button" variant="secondary">
                <Play size={14} /> Вызвать
              </Button>
              <Button onClick={() => void reloadPlugin()} type="button" variant="secondary">
                <RefreshCw size={14} /> Перезагрузить
              </Button>
              <Button onClick={() => void restartPlugin()} type="button" variant="warn">
                <RotateCcw size={14} /> Перезапустить
              </Button>
              <Button onClick={() => selected && void loadDetails(selected)} type="button" variant="secondary">
                Обновить
              </Button>
            </div>
            {status && (
              <div style={{ marginTop: '0.65rem' }}>
                <InlineFeedback tone="success">{status}</InlineFeedback>
              </div>
            )}
          </div>

          <div className="card">
            <div className="card-header">
              <FileCode2 size={15} className="card-icon" />
              <span className="card-title">Состояние</span>
            </div>
            {loadingDetails && <Skeleton className="h-24" />}
            <pre className="code-block">{details ? JSON.stringify(details.plugin, null, 2) : '—'}</pre>
          </div>

          <div className="card">
            <div className="card-header">
              <FileCode2 size={15} className="card-icon card-icon-pink" />
              <span className="card-title">Конфиг модуля</span>
            </div>
            <textarea className="textarea" onChange={(e) => setConfigText(e.target.value)} style={{ minHeight: 200 }} value={configText} />
            <div className="row" style={{ marginTop: '0.75rem' }}>
              <Button onClick={() => void saveConfig()} type="button">
                Сохранить конфиг
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
