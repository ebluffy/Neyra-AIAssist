import { useCallback, useEffect, useRef, useState } from 'react'
import {
  FilePlus,
  FileCode2,
  Play,
  Power,
  Puzzle,
  RefreshCw,
  ScrollText,
  Settings2,
  ToggleLeft,
  ToggleRight,
  Trash2,
  Upload,
} from 'lucide-react'
import { ApiRequestError, apiDelete, apiGet, apiPatch, apiPost, apiPut, apiUpload } from '../api'
import type { ApiEnvelope, PluginFileRow, PluginLogSource, PluginRow } from '../api'
import { LogViewer } from '../components/LogViewer'
import type { LogSource } from '../components/LogViewer'
import { Button } from '../components/ui/button'
import { EmptyState } from '../components/ui/empty-state'
import { InlineFeedback } from '../components/ui/inline-feedback'
import { PageHeader } from '../components/ui/page-header'
import { Skeleton } from '../components/ui/skeleton'
import { waitForCoreRestart } from '../lib/wait-for-core-restart'

type PluginDetails = { plugin: PluginRow; config: Record<string, unknown> }
type Tab = 'manage' | 'configs' | 'logs'

/** Pseudo-file: module config via PUT /v1/plugins/{id}/config (JSON). */
const JSON_CONFIG = '@json'
/** Modules that the API refuses to delete. */
const PROTECTED_PLUGINS = ['discord']
const MAX_UPLOAD_MB = 20
const CONFIG_SUFFIXES = ['.yaml', '.yml', '.json', '.toml', '.ini', '.conf', '.properties']

function isAlreadyExists(e: unknown): boolean {
  if (e instanceof ApiRequestError && (e.status === 409 || e.code === 'already_exists')) return true
  const msg = e instanceof Error ? e.message : String(e)
  return /already exists|already_exists/i.test(msg)
}

function fileSuffix(path: string): string {
  const name = path.split('/').pop() ?? path
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i).toLowerCase() : ''
}

/** Path without its extension, used to spot JSON↔YAML name clashes. */
function fileStem(path: string): string {
  const s = fileSuffix(path)
  return s ? path.slice(0, -s.length).toLowerCase() : path.toLowerCase()
}

function lifeLabel(v: unknown): string {
  const s = String(v || '').toLowerCase()
  if (s === 'on_demand') return 'on-demand'
  return s || '—'
}

/** Quote 16+ digit integer literals so JSON.parse does not corrupt Discord snowflakes. */
function parsePluginConfigJson(text: string): Record<string, unknown> {
  const quoted = text.replace(/(?<!["\w])(-?\d{16,})(?![\d."\w])/g, '"$1"')
  const parsed = JSON.parse(quoted) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Конфиг должен быть JSON-объектом')
  }
  return parsed as Record<string, unknown>
}

function filePathUrl(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} Б`
  return `${(n / 1024).toFixed(1)} КБ`
}

export function ModulesScreen() {
  const [plugins, setPlugins] = useState<PluginRow[]>([])
  const [selected, setSelected] = useState('')
  const [details, setDetails] = useState<PluginDetails | null>(null)
  const [tab, setTab] = useState<Tab>('manage')
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loadingPlugins, setLoadingPlugins] = useState(false)
  const [loadingDetails, setLoadingDetails] = useState(false)
  const [restartBusy, setRestartBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [apiLogSources, setApiLogSources] = useState<LogSource[] | null>(null)
  const uploadRef = useRef<HTMLInputElement>(null)

  // Configs tab
  const [files, setFiles] = useState<PluginFileRow[]>([])
  const [loadingFiles, setLoadingFiles] = useState(false)
  const [activeFile, setActiveFile] = useState('')
  const [fileText, setFileText] = useState('')
  const [fileOriginal, setFileOriginal] = useState('')
  const [fileBusy, setFileBusy] = useState(false)
  const [fileStatus, setFileStatus] = useState('')

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
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoadingDetails(false)
    }
  }, [])

  const openFile = useCallback(
    async (id: string, path: string, config?: Record<string, unknown>) => {
      setActiveFile(path)
      setFileStatus('')
      if (path === JSON_CONFIG) {
        const text = JSON.stringify(config ?? {}, null, 2)
        setFileText(text)
        setFileOriginal(text)
        return
      }
      setFileBusy(true)
      try {
        const r = await apiGet<ApiEnvelope<{ content: string }>>(`/v1/plugins/${id}/files/${filePathUrl(path)}`)
        setFileText(r.data.content)
        setFileOriginal(r.data.content)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        setFileText('')
        setFileOriginal('')
      } finally {
        setFileBusy(false)
      }
    },
    [],
  )

  const loadFiles = useCallback(
    async (id: string, config?: Record<string, unknown>) => {
      setLoadingFiles(true)
      try {
        const r = await apiGet<ApiEnvelope<{ files: PluginFileRow[] }>>(`/v1/plugins/${id}/files`)
        const list = r.data.files ?? []
        setFiles(list)
        const first = list.find((f) => f.path === 'config.yaml') ?? list[0]
        await openFile(id, first ? first.path : JSON_CONFIG, config)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        setFiles([])
      } finally {
        setLoadingFiles(false)
      }
    },
    [openFile],
  )

  useEffect(() => {
    void loadPlugins()
  }, [loadPlugins])

  useEffect(() => {
    setFiles([])
    setActiveFile('')
    setFileText('')
    setFileOriginal('')
    setFileStatus('')
    if (selected) void loadDetails(selected)
    else setDetails(null)
  }, [selected, loadDetails])

  // Log sources from the API; null = not loaded yet or failed (hardcoded fallback is used).
  useEffect(() => {
    setApiLogSources(null)
    if (!selected) return
    let cancelled = false
    apiGet<ApiEnvelope<{ sources?: PluginLogSource[] }>>(`/v1/plugins/${selected}/log-sources`)
      .then((r) => {
        if (cancelled) return
        const list = (r.data.sources ?? []).filter((s) => s && s.id).map((s) => ({ id: s.id, label: s.label || s.id }))
        setApiLogSources(list.length > 0 ? list : null)
      })
      .catch(() => {
        if (!cancelled) setApiLogSources(null)
      })
    return () => {
      cancelled = true
    }
  }, [selected])

  // Load the file list once per module when the Configs tab is opened.
  useEffect(() => {
    if (tab !== 'configs' || !selected || !details || details.plugin.id !== selected) return
    if (files.length > 0 || activeFile) return
    void loadFiles(selected, details.config)
  }, [tab, selected, details, files.length, activeFile, loadFiles])

  const lifecycle = (details?.plugin.lifecycle || '').toLowerCase()
  const isResident = lifecycle === 'resident'
  const isOnDemand = lifecycle === 'on_demand'
  const isProtected = PROTECTED_PLUGINS.includes(selected)
  const fileDirty = fileText !== fileOriginal

  async function finishRestartWait(prefix: string, reload = true) {
    setRestartBusy(true)
    try {
      const outcome = await waitForCoreRestart()
      if (outcome === 'online') {
        setStatus(`${prefix} Сервер снова онлайн.`)
        await loadPlugins()
        if (reload && selected) await loadDetails(selected)
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
    if (!selected || restartBusy) return
    setError(null)
    setRestartBusy(true)
    setStatus(enabled ? 'Включаю…' : 'Выключаю…')
    try {
      const r = await apiPatch<
        ApiEnvelope<{
          operation_id: string
          result?: {
            lavalink?: string | null
            restart_scheduled?: boolean
            restart_required?: boolean
            enabled_changed?: boolean
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
        // No-op PATCH or older cores without restart_scheduled.
        setStatus(
          r.data.result?.enabled_changed === false
            ? `Состояние уже ${enabled ? 'вкл.' : 'выкл.'} — рестарт не нужен.`
            : enabled
              ? `Модуль включён в конфиге.${lavaBit} Нужен мягкий рестарт ядра.`
              : `Модуль выключен в конфиге.${lavaBit} Нужен мягкий рестарт ядра.`,
        )
        await loadPlugins()
        await loadDetails(selected)
        if (
          r.data.result?.enabled_changed !== false &&
          window.confirm(
            enabled
              ? 'Resident-модуль записан как включённый. Сделать мягкий рестарт ядра сейчас, чтобы бот реально стартовал?'
              : 'Resident-модуль записан как выключенный. Сделать мягкий рестарт ядра сейчас, чтобы остановить поток?',
          )
        ) {
          await softRestartCore(true)
          return
        }
        setRestartBusy(false)
        return
      }
      setStatus(`Готово: ${r.data.operation_id}`)
      await loadPlugins()
      await loadDetails(selected)
      setRestartBusy(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setRestartBusy(false)
    }
  }

  async function saveFile() {
    if (!selected || !activeFile) return
    setError(null)
    setFileStatus('Сохраняю…')
    try {
      if (activeFile === JSON_CONFIG) {
        const parsed = parsePluginConfigJson(fileText)
        await apiPut<ApiEnvelope<{ operation_id: string }>>(`/v1/plugins/${selected}/config`, { config: parsed })
        await loadDetails(selected)
      } else {
        await apiPut<ApiEnvelope<{ saved: boolean }>>(`/v1/plugins/${selected}/files/${filePathUrl(activeFile)}`, {
          content: fileText,
        })
      }
      setFileOriginal(fileText)
      setFileStatus(
        isResident ? 'Сохранено. Resident-модуль подхватит изменения после рестарта ядра.' : 'Сохранено.',
      )
      if (
        isResident &&
        window.confirm(
          `Конфиг resident-модуля «${selected}» сохранён. Сделать мягкий рестарт ядра сейчас, чтобы изменения вступили в силу?`,
        )
      ) {
        await softRestartCore(true)
      }
    } catch (e) {
      setFileStatus('')
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function createConfigFile() {
    if (!selected) return
    const raw = window.prompt(
      `Путь нового файла относительно папки модуля.\nДопустимые расширения: ${CONFIG_SUFFIXES.join(', ')}`,
      'config.yaml',
    )
    if (raw == null) return
    const path = raw.trim().replace(/^\.\//, '')
    if (!path) return
    if (path.startsWith('/') || path.includes('\\') || path.split('/').some((p) => p === '..' || p === '')) {
      setError('Нужен относительный путь внутри модуля без «..» и обратных слэшей.')
      return
    }
    const suffix = fileSuffix(path)
    if (!CONFIG_SUFFIXES.includes(suffix)) {
      setError(`Расширение «${suffix || '—'}» не разрешено. Допустимо: ${CONFIG_SUFFIXES.join(', ')}`)
      return
    }
    if (fileDirty && !window.confirm('Есть несохранённые правки. Открыть новый файл без сохранения?')) return
    if (files.some((f) => f.path === path)) {
      setError(null)
      void openFile(selected, path, details?.config)
      setFileStatus('Такой файл уже есть — открыт для правки.')
      return
    }
    const isStructured = (s: string) => ['.json', '.yaml', '.yml'].includes(s)
    const clash = files.find(
      (f) =>
        fileStem(f.path) === fileStem(path) &&
        f.path !== path &&
        isStructured(fileSuffix(f.path)) &&
        isStructured(suffix) &&
        (fileSuffix(f.path) === '.json') !== (suffix === '.json'),
    )
    if (
      clash &&
      !window.confirm(
        `Рядом уже лежит «${clash.path}». Смена формата JSON↔YAML под тем же именем может перекрыть или запутать загрузку конфига модуля. Всё равно создать «${path}»?`,
      )
    ) {
      return
    }
    setError(null)
    setFileBusy(true)
    setFileStatus('Создаю файл…')
    try {
      const content = suffix === '.json' ? '{}\n' : ''
      await apiPut<ApiEnvelope<{ saved: boolean }>>(`/v1/plugins/${selected}/files/${filePathUrl(path)}`, { content })
      const r = await apiGet<ApiEnvelope<{ files: PluginFileRow[] }>>(`/v1/plugins/${selected}/files`)
      setFiles(r.data.files ?? [])
      setActiveFile(path)
      setFileText(content)
      setFileOriginal(content)
      setFileStatus(`Файл «${path}» создан.`)
    } catch (e) {
      setFileStatus('')
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setFileBusy(false)
    }
  }

  async function reloadOrRestartPlugin(kind: 'reload' | 'restart') {
    if (!selected || restartBusy) return
    const label = kind === 'reload' ? 'Перезагрузить' : 'Перезапустить'
    if (isResident) {
      const lava = selected === 'discord' ? ' Discord-бот и Lavalink отключатся и поднимутся заново.' : ''
      if (
        !window.confirm(
          `${label} resident-модуль «${selected}»? Для него это мягкий рестарт всего ядра.${lava} Дашборд на несколько секунд отвалится.`,
        )
      ) {
        return
      }
    }
    setError(null)
    setRestartBusy(true)
    setStatus(kind === 'reload' ? 'Перезагружаю модуль…' : 'Перезапускаю модуль…')
    try {
      const r = await apiPost<ApiEnvelope<{ restart_scheduled?: boolean; message?: string }>>(
        `/v1/plugins/${selected}/${kind}`,
        {},
      )
      if (r.data.restart_scheduled) {
        setStatus('Ядро перезапускается…')
        await finishRestartWait(kind === 'reload' ? 'Модуль перезагружен.' : 'Модуль перезапущен.')
        return
      }
      setStatus(r.data.message || (kind === 'reload' ? 'Модуль перезагружен.' : 'Модуль перезапущен.'))
      await loadPlugins()
      await loadDetails(selected)
      setRestartBusy(false)
    } catch (e) {
      setStatus('')
      setError(e instanceof Error ? e.message : String(e))
      setRestartBusy(false)
    }
  }

  function pickFile(path: string) {
    if (path === activeFile) return
    if (fileDirty && !window.confirm('Есть несохранённые правки. Переключить файл без сохранения?')) return
    void openFile(selected, path, details?.config)
  }

  function pickPlugin(id: string) {
    if (id === selected) return
    if (fileDirty && !window.confirm('Есть несохранённые правки. Переключить модуль без сохранения?')) return
    setSelected(id)
  }

  async function invokePlugin() {
    if (!selected || !isOnDemand) return
    setError(null)
    setStatus('Вызов…')
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
    setRestartBusy(true)
    setStatus('Мягкий рестарт… ждём подъёма API')
    try {
      await apiPost<ApiEnvelope<{ note?: string }>>('/v1/system/restart', {})
      await finishRestartWait('Мягкий рестарт.')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setRestartBusy(false)
    }
  }

  async function onUploadPicked(file: File | undefined) {
    if (uploadRef.current) uploadRef.current.value = ''
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.zip')) {
      setError('Нужен .zip-архив с plugin.yaml внутри')
      return
    }
    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
      setError(`Файл больше ${MAX_UPLOAD_MB} МБ — сервер его не примет.`)
      return
    }
    setError(null)
    setUploading(true)
    setStatus(`Загружаю ${file.name}…`)
    try {
      let r: ApiEnvelope<{ plugin_id: string; restart_scheduled?: boolean }>
      try {
        r = await apiUpload('/v1/plugins/upload', file)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (!isAlreadyExists(e)) throw e
        if (
          !window.confirm(
            `${msg}\n\nЗаменить существующий модуль? Локальные config.yaml, logs/ и data/ сохранятся. Resident — с soft-restart.`,
          )
        ) {
          setStatus('')
          return
        }
        r = await apiUpload('/v1/plugins/upload?replace=true', file)
      }
      const pid = r.data.plugin_id
      if (r.data.restart_scheduled) {
        setStatus(`Модуль «${pid}» заменён. Ядро перезапускается…`)
        setRestartBusy(true)
        await finishRestartWait(`Модуль «${pid}» заменён.`)
      } else {
        setStatus(`Модуль «${pid}» установлен. Включи его вручную во вкладке «Управление».`)
      }
      await loadPlugins()
      setSelected(pid)
      setTab('manage')
    } catch (e) {
      setStatus('')
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setUploading(false)
    }
  }

  async function deletePlugin() {
    if (!selected || isProtected || restartBusy) return
    const warn = isResident
      ? ' Это resident-модуль — ядро будет перезапущено.'
      : ''
    if (!window.confirm(`Удалить модуль «${selected}» вместе с его папкой? Действие необратимо.${warn}`)) return
    setError(null)
    setRestartBusy(true)
    setStatus('Удаляю…')
    try {
      const r = await apiDelete<ApiEnvelope<{ deleted: boolean; plugin_id: string; restart_scheduled?: boolean }>>(
        `/v1/plugins/${selected}`,
      )
      if (r.data.restart_scheduled) {
        setStatus('Модуль удалён. Ядро перезапускается…')
        await finishRestartWait('Модуль удалён.', false)
        return
      }
      setStatus(`Модуль «${selected}» удалён.`)
      await loadPlugins()
      setRestartBusy(false)
    } catch (e) {
      setStatus('')
      setError(e instanceof Error ? e.message : String(e))
      setRestartBusy(false)
    }
  }

  const fallbackLogSources: LogSource[] = selected
    ? [
        { id: `plugin:${selected}`, label: 'Модуль' },
        ...(selected === 'discord' ? [{ id: 'lavalink', label: 'Lavalink' }] : []),
      ]
    : []
  const logSources: LogSource[] = apiLogSources ?? fallbackLogSources

  const tabs: [Tab, string, typeof Settings2][] = [
    ['manage', 'Управление', Settings2],
    ['configs', 'Конфиги', FileCode2],
    ['logs', 'Логи', ScrollText],
  ]

  return (
    <div className="page-content stack">
      <PageHeader
        title="Модули"
        subtitle="Установка, включение, конфиги и логи"
        actions={
          <>
            <input
              accept=".zip,application/zip"
              hidden
              onChange={(e) => void onUploadPicked(e.target.files?.[0])}
              ref={uploadRef}
              type="file"
            />
            <Button disabled={uploading || restartBusy} onClick={() => uploadRef.current?.click()} type="button" variant="cyan">
              <Upload size={14} /> {uploading ? 'Загрузка…' : 'Загрузить .zip'}
            </Button>
          </>
        }
      />
      {error && <InlineFeedback tone="error">{error}</InlineFeedback>}
      {status && <InlineFeedback tone="success">{status}</InlineFeedback>}

      <div
        className={`dropzone${dragging ? ' dragging' : ''}`}
        onDragLeave={() => setDragging(false)}
        onDragOver={(e) => {
          e.preventDefault()
          if (!uploading && !restartBusy) setDragging(true)
        }}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          if (uploading || restartBusy) return
          void onUploadPicked(e.dataTransfer.files?.[0])
        }}
      >
        <span className="hint">
          <Upload size={13} style={{ verticalAlign: '-2px' }} /> Перетащи сюда .zip с <code className="inline-code">plugin.yaml</code>{' '}
          или выбери файл. Максимум {MAX_UPLOAD_MB} МБ.
        </span>
        <Button disabled={uploading || restartBusy} onClick={() => uploadRef.current?.click()} size="sm" type="button" variant="secondary">
          Выбрать файл
        </Button>
      </div>

      <div className="split-modules">
        <div className="card" style={{ height: 'fit-content' }}>
          <div className="card-header">
            <Puzzle size={15} className="card-icon" />
            <span className="card-title">Установлено ({plugins.length})</span>
          </div>
          <div className="stack-sm">
            {loadingPlugins && plugins.length === 0 && [1, 2, 3].map((i) => <Skeleton key={i} className="h-10" />)}
            {plugins.map((p) => (
              <button
                key={p.id}
                className={`plugin-item${selected === p.id ? ' active' : ''}`}
                onClick={() => pickPlugin(p.id)}
                type="button"
              >
                <span style={{ fontFamily: 'var(--mono)', fontSize: '0.8rem', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {p.id}
                </span>
                <span className="plugin-item-meta">
                  <span className={`status-dot ${p.enabled ? 'status-dot-ok' : 'status-dot-idle'}`} />
                  {p.enabled ? 'вкл.' : 'выкл.'}
                  <span
                    className={`life-badge${String(p.lifecycle).toLowerCase() === 'resident' ? ' life-badge-resident' : ''}`}
                  >
                    {lifeLabel(p.lifecycle)}
                  </span>
                </span>
              </button>
            ))}
            {!loadingPlugins && plugins.length === 0 && (
              <EmptyState icon={Puzzle} title="Нет модулей" description="Загрузи .zip с plugin.yaml." />
            )}
          </div>
        </div>

        <div className="card">
          {!selected ? (
            <EmptyState icon={Settings2} title="Выбери модуль" description="Список слева." />
          ) : (
            <>
              <div className="row" style={{ justifyContent: 'space-between', marginBottom: '0.9rem' }}>
                <div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: '1rem', fontWeight: 600 }}>
                    {details?.plugin.name || selected}
                  </div>
                  <div className="hint">
                    <span style={{ fontFamily: 'var(--mono)' }}>{selected}</span>
                    {details?.plugin.version ? ` · v${details.plugin.version}` : ''}
                    {details?.plugin.description ? ` · ${details.plugin.description}` : ''}
                  </div>
                </div>
              </div>

              <div className="panel-tabs panel-tabs-dense" role="tablist">
                {tabs.map(([id, label, Icon]) => (
                  <button
                    key={id}
                    aria-selected={tab === id}
                    className={`panel-tab${tab === id ? ' active' : ''}`}
                    onClick={() => setTab(id)}
                    role="tab"
                    type="button"
                  >
                    <Icon size={14} /> {label}
                  </button>
                ))}
              </div>

              {tab === 'manage' && (
                <div className="stack">
                  {details && (
                    <p className="hint">
                      {isResident
                        ? 'Resident: работает в процессе ядра. Вкл./выкл. пишет конфиг и сразу мягко перезапускает ядро, чтобы поток реально стартовал или остановился.'
                        : isOnDemand
                          ? 'On-demand: «Вызвать» запускает entrypoint модуля, «Перезагрузить модуль» перечитывает манифест и код без рестарта ядра.'
                          : `Lifecycle «${lifecycle || '—'}»: доступны вкл./выкл. и конфиг.`}
                      {selected === 'discord' ? ' Discord дополнительно стартует и останавливает managed Lavalink.' : ''}
                    </p>
                  )}
                  <div className="row">
                    <button
                      aria-label="включить или выключить модуль"
                      className={`toggle-pill ${details?.plugin.enabled ? 'toggle-on' : 'toggle-off'}`}
                      disabled={restartBusy || loadingDetails}
                      onClick={() => void togglePlugin(!Boolean(details?.plugin.enabled))}
                      type="button"
                    >
                      {details?.plugin.enabled ? <ToggleRight size={18} /> : <ToggleLeft size={18} />}
                      {details?.plugin.enabled ? 'Включён' : 'Выключен'}
                    </button>
                    {isOnDemand && (
                      <Button onClick={() => void invokePlugin()} type="button" variant="secondary">
                        <Play size={14} /> Вызвать
                      </Button>
                    )}
                    <Button
                      disabled={restartBusy || loadingDetails}
                      onClick={() => void reloadOrRestartPlugin('reload')}
                      title={isResident ? 'Resident: мягкий рестарт ядра' : 'Перечитать модуль без рестарта ядра'}
                      type="button"
                      variant="secondary"
                    >
                      <RefreshCw size={14} /> Перезагрузить модуль
                    </Button>
                    <Button
                      disabled={restartBusy || loadingDetails}
                      onClick={() => void reloadOrRestartPlugin('restart')}
                      title={isResident ? 'Resident: мягкий рестарт ядра' : 'Перезапустить модуль'}
                      type="button"
                      variant="warn"
                    >
                      <Power size={14} /> Рестарт
                    </Button>
                    {isResident && (
                      <Button disabled={restartBusy} onClick={() => void softRestartCore()} type="button" variant="warn">
                        <Power size={14} /> {restartBusy ? 'Рестарт…' : 'Рестарт ядра'}
                      </Button>
                    )}
                    <Button
                      disabled={restartBusy}
                      onClick={() => void loadDetails(selected)}
                      type="button"
                      variant="secondary"
                    >
                      Обновить
                    </Button>
                    <span style={{ flex: 1 }} />
                    <Button
                      disabled={restartBusy || isProtected}
                      onClick={() => void deletePlugin()}
                      title={isProtected ? 'Системный модуль — удаление запрещено' : 'Удалить модуль'}
                      type="button"
                      variant="danger"
                    >
                      <Trash2 size={14} /> Удалить
                    </Button>
                  </div>
                  {isProtected && <p className="hint">Модуль «{selected}» защищён: удалить или перезаписать его через API нельзя.</p>}

                  <hr className="divider" style={{ margin: 0 }} />
                  <div>
                    <div className="section-title">Состояние</div>
                    {loadingDetails && !details ? (
                      <Skeleton className="h-24" />
                    ) : (
                      <pre className="code-block" style={{ maxHeight: 280 }}>
                        {details ? JSON.stringify(details.plugin, null, 2) : '—'}
                      </pre>
                    )}
                  </div>
                </div>
              )}

              {tab === 'configs' && (
                <div className="split-files">
                  <div>
                    <div className="row" style={{ justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                      <div className="section-title" style={{ marginBottom: 0 }}>Файлы</div>
                      <Button
                        disabled={fileBusy || loadingFiles}
                        onClick={() => void createConfigFile()}
                        size="sm"
                        title="Новый конфиг-файл в папке модуля"
                        type="button"
                        variant="secondary"
                      >
                        <FilePlus size={13} /> Новый
                      </Button>
                    </div>
                    <div className="file-list">
                      {loadingFiles && files.length === 0 && <Skeleton className="h-10" />}
                      {files.map((f) => (
                        <button
                          key={f.path}
                          className={`file-item${activeFile === f.path ? ' active' : ''}`}
                          onClick={() => pickFile(f.path)}
                          title={f.path}
                          type="button"
                        >
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.path}</span>
                          <span className="file-item-size">{fmtBytes(f.bytes)}</span>
                        </button>
                      ))}
                      <button
                        className={`file-item${activeFile === JSON_CONFIG ? ' active' : ''}`}
                        onClick={() => pickFile(JSON_CONFIG)}
                        title="Параметры модуля через API (JSON)"
                        type="button"
                      >
                        <span>Параметры (JSON)</span>
                      </button>
                    </div>
                  </div>
                  <div className="stack-sm">
                    <div className="row" style={{ justifyContent: 'space-between' }}>
                      <span style={{ fontFamily: 'var(--mono)', fontSize: '0.8rem', color: 'var(--muted)' }}>
                        {activeFile === JSON_CONFIG ? 'Параметры модуля (JSON)' : activeFile || '—'}
                        {fileDirty && <span style={{ color: 'var(--amber)' }}> · изменён</span>}
                      </span>
                      <div className="row">
                        <Button
                          disabled={!fileDirty || fileBusy}
                          onClick={() => setFileText(fileOriginal)}
                          size="sm"
                          type="button"
                          variant="secondary"
                        >
                          Сбросить
                        </Button>
                        <Button disabled={!activeFile || !fileDirty || fileBusy} onClick={() => void saveFile()} size="sm" type="button">
                          Сохранить
                        </Button>
                      </div>
                    </div>
                    {activeFile ? (
                      <textarea
                        className="textarea"
                        disabled={fileBusy}
                        onChange={(e) => setFileText(e.target.value)}
                        spellCheck={false}
                        style={{ minHeight: 360 }}
                        value={fileText}
                      />
                    ) : (
                      !loadingFiles && <EmptyState icon={FileCode2} title="Нет файла" description="Выбери файл слева." />
                    )}
                    {fileStatus && <InlineFeedback tone="success">{fileStatus}</InlineFeedback>}
                  </div>
                </div>
              )}

              {tab === 'logs' && <LogViewer key={`${selected}:${logSources.map((s) => s.id).join('|')}`} sources={logSources} />}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
