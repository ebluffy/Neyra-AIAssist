import { useCallback, useEffect, useState } from 'react'
import { FileCode2, Play, Power, Settings2, ToggleLeft, ToggleRight } from 'lucide-react'
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
  const [restartBusy, setRestartBusy] = useState(false)

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

  const lifecycle = (details?.plugin.lifecycle || '').toLowerCase()
  const isResident = lifecycle === 'resident'
  const isOnDemand = lifecycle === 'on_demand'

  async function togglePlugin(enabled: boolean) {
    if (!selected) return
    setError(null)
    setStatus(enabled ? 'Включаю…' : 'Выключаю…')
    try {
      const r = await apiPatch<
        ApiEnvelope<{ operation_id: string; result?: { lavalink?: string | null } }>
      >(`/v1/plugins/${selected}`, { enabled })
      const lava = r.data.result?.lavalink
      if (isResident) {
        const lavaBit = selected === 'discord' && lava ? ` Lavalink: ${lava}.` : ''
        setStatus(
          enabled
            ? `Модуль включён в конфиге.${lavaBit} Поток resident поднимается только мягким рестартом ядра.`
            : `Модуль выключен в конфиге.${lavaBit} Поток resident гасится только мягким рестартом ядра.`,
        )
      } else {
        setStatus(`Готово: ${r.data.operation_id}`)
      }
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
    if (!selected || !isOnDemand) return
    setError(null)
    setStatus('Вызов...')
    try {
      await apiPost<ApiEnvelope<unknown>>(`/v1/plugins/${selected}/invoke`, { payload: {} })
      setStatus('Вызов выполнен')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function softRestartCore() {
    if (
      !window.confirm(
        'Мягкий рестарт всего процесса Neyra? Resident-модули (Discord) и Lavalink поднимутся заново. Дашборд на несколько секунд отвалится.',
      )
    ) {
      return
    }
    setRestartBusy(true)
    setError(null)
    setStatus('Мягкий рестарт… ждём подъёма API')
    try {
      await apiPost<ApiEnvelope<{ note?: string }>>('/v1/system/restart', {})
      let online = false
      for (let i = 0; i < 45; i++) {
        await new Promise((r) => setTimeout(r, 2000))
        try {
          const r = await fetch('/v1/dashboard/auth/status', { headers: { Accept: 'application/json' } })
          if (!r.ok) continue
          const text = await r.text()
          if (text.trimStart().startsWith('<')) continue
          const j = JSON.parse(text) as { ok?: boolean }
          if (j?.ok === true) {
            online = true
            break
          }
        } catch {
          /* still down */
        }
      }
      setStatus(online ? 'Сервер снова онлайн.' : 'Долго не отвечает — обнови страницу через минуту.')
      if (online) {
        await loadPlugins()
        if (selected) await loadDetails(selected)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRestartBusy(false)
    }
  }

  return (
    <div className="page-content stack">
      <PageHeader title="Модули" subtitle="Включение, конфиг и жизненный цикл" />
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
                    <span style={{ color: 'var(--muted)', fontFamily: 'var(--mono)' }}>
                      {String(p.lifecycle || '—')}
                    </span>
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
            {details && (
              <p style={{ fontSize: '0.8rem', color: 'var(--muted)', marginBottom: '0.75rem', lineHeight: 1.45 }}>
                {isResident
                  ? 'Resident: работает в процессе ядра. Вкл./выкл. пишет конфиг; живой поток гасится/поднимается мягким рестартом ядра.'
                  : isOnDemand
                    ? 'On-demand: «Вызвать» запускает entrypoint модуля. Reload/restart модуля API пока не поддерживает.'
                    : `Lifecycle «${lifecycle || '—'}»: доступны вкл./выкл. и конфиг.`}
                {selected === 'discord' ? ' Discord дополнительно стартует/останавливает managed Lavalink.' : ''}
              </p>
            )}
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
              {isOnDemand && (
                <Button onClick={() => void invokePlugin()} type="button" variant="secondary">
                  <Play size={14} /> Вызвать
                </Button>
              )}
              {isResident && (
                <Button disabled={restartBusy} onClick={() => void softRestartCore()} type="button" variant="warn">
                  <Power size={14} /> {restartBusy ? 'Рестарт…' : 'Мягкий рестарт ядра'}
                </Button>
              )}
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
