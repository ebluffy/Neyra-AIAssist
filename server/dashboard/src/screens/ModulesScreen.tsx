import { useCallback, useEffect, useState } from 'react'
import { FileCode2, Play, Power, Settings2, ToggleLeft, ToggleRight } from 'lucide-react'
import { apiGet, apiPatch, apiPost, apiPut } from '../api'
import type { ApiEnvelope, PluginRow } from '../api'
import { Button } from '../components/ui/button'
import { EmptyState } from '../components/ui/empty-state'
import { InlineFeedback } from '../components/ui/inline-feedback'
import { PageHeader } from '../components/ui/page-header'
import { Skeleton } from '../components/ui/skeleton'
import { waitForCoreRestart } from '../lib/wait-for-core-restart'

type PluginDetails = { plugin: PluginRow; config: Record<string, unknown> }

/** Quote 16+ digit integer literals so JSON.parse does not corrupt Discord snowflakes. */
function parsePluginConfigJson(text: string): Record<string, unknown> {
  const quoted = text.replace(/(?<!["\w])(-?\d{16,})(?![\d."\w])/g, '"$1"')
  const parsed = JSON.parse(quoted) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Конфиг должен быть JSON-объектом')
  }
  return parsed as Record<string, unknown>
}

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

  async function finishRestartWait(prefix: string) {
    setRestartBusy(true)
    try {
      const outcome = await waitForCoreRestart()
      if (outcome === 'online') {
        setStatus(`${prefix} Сервер снова онлайн.`)
        await loadPlugins()
        if (selected) await loadDetails(selected)
        return
      }
      if (outcome === 'no_downtime') {
        setError(
          'Мягкий рестарт не остановил процесс (API не уходил в offline). Проверь systemd/логи или сделай systemctl restart neyra.',
        )
        setStatus(`${prefix} Рестарт не подтверждён.`)
        return
      }
      setStatus(`${prefix} Долго не отвечает — обнови страницу через минуту.`)
    } finally {
      setRestartBusy(false)
    }
  }

  async function togglePlugin(enabled: boolean) {
    if (!selected) return
    setError(null)
    setStatus(enabled ? 'Включаю…' : 'Выключаю…')
    try {
      const r = await apiPatch<
        ApiEnvelope<{
          operation_id: string
          result?: {
            lavalink?: string | null
            restart_scheduled?: boolean
            restart_required?: boolean
          }
        }>
      >(`/v1/plugins/${selected}`, { enabled })
      const lava = r.data.result?.lavalink
      const lavaBit = selected === 'discord' && lava ? ` Lavalink: ${lava}.` : ''
      const restartScheduled = Boolean(r.data.result?.restart_scheduled)
      if (isResident && restartScheduled) {
        setStatus(
          enabled
            ? `Модуль включён.${lavaBit} Ядро перезапускается…`
            : `Модуль выключен.${lavaBit} Ядро перезапускается, чтобы остановить поток…`,
        )
        await finishRestartWait(enabled ? 'Модуль включён.' : 'Модуль выключен.')
        return
      }
      if (isResident) {
        // Older cores without restart_scheduled — keep confirm + explicit restart.
        setStatus(
          enabled
            ? `Модуль включён в конфиге.${lavaBit} Нужен мягкий рестарт ядра.`
            : `Модуль выключен в конфиге.${lavaBit} Нужен мягкий рестарт ядра.`,
        )
        await loadPlugins()
        await loadDetails(selected)
        if (
          window.confirm(
            enabled
              ? 'Resident-модуль записан как включённый. Сделать мягкий рестарт ядра сейчас, чтобы бот реально стартовал?'
              : 'Resident-модуль записан как выключенный. Сделать мягкий рестарт ядра сейчас, чтобы остановить поток?',
          )
        ) {
          await softRestartCore(true)
        }
        return
      }
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
      const parsed = parsePluginConfigJson(configText)
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

  async function softRestartCore(skipConfirm = false) {
    if (
      !skipConfirm &&
      !window.confirm(
        'Мягкий рестарт всего процесса Neyra? Resident-модули (Discord) и Lavalink поднимутся заново. Дашборд на несколько секунд отвалится.',
      )
    ) {
      return
    }
    setError(null)
    setStatus('Мягкий рестарт… ждём подъёма API')
    try {
      await apiPost<ApiEnvelope<{ note?: string }>>('/v1/system/restart', {})
      await finishRestartWait('Мягкий рестарт.')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
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
                  <span style={{ fontFamily: 'var(--mono)', fontSize: '0.8rem', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {p.id}
                  </span>
                  <span className="plugin-item-meta">
                    <span className={`status-dot ${p.enabled ? 'status-dot-ok' : 'status-dot-idle'}`} />
                    {p.enabled ? 'вкл.' : 'выкл.'}
                    <span className="plugin-item-life">{String(p.lifecycle || '—')}</span>
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
                  ? 'Resident: работает в процессе ядра. Вкл./выкл. пишет конфиг и сразу мягко перезапускает ядро, чтобы поток реально стартовал/остановился.'
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
                  <Power size={14} /> {restartBusy ? 'Рестарт…' : 'Рестарт ядра'}
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
