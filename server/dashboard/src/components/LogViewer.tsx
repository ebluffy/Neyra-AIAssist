import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDownToLine, Copy, Pause, Play, RefreshCw, WrapText } from 'lucide-react'
import { apiGet } from '../api'
import type { ApiEnvelope, LogTailData } from '../api'
import { Button } from './ui/button'
import { InlineFeedback } from './ui/inline-feedback'
import { Skeleton } from './ui/skeleton'

export type LogSource = { id: string; label: string }

type Props = {
  sources: LogSource[]
}

type LogLevel = 'ERROR' | 'WARN' | 'INFO' | 'DEBUG' | 'OTHER'

type LogRow = { n: number; text: string; level: LogLevel }

const TAIL_OPTIONS = [100, 200, 500, 1000, 2000]
const LEVELS: LogLevel[] = ['ERROR', 'WARN', 'INFO', 'DEBUG', 'OTHER']

const LEVEL_RE =
  /\b(ERROR|ERR|FATAL|CRITICAL|WARN(?:ING)?|INFO|DEBUG|TRACE)\b/i

function detectLevel(line: string): LogLevel {
  const m = line.match(LEVEL_RE)
  if (!m) return 'OTHER'
  const raw = m[1].toUpperCase()
  if (raw === 'ERR' || raw === 'FATAL' || raw === 'CRITICAL') return 'ERROR'
  if (raw === 'WARNING') return 'WARN'
  if (raw === 'TRACE') return 'DEBUG'
  if (raw === 'ERROR' || raw === 'WARN' || raw === 'INFO' || raw === 'DEBUG') return raw
  return 'OTHER'
}

function levelClass(level: LogLevel): string {
  switch (level) {
    case 'ERROR':
      return 'log-line-error'
    case 'WARN':
      return 'log-line-warn'
    case 'INFO':
      return 'log-line-info'
    case 'DEBUG':
      return 'log-line-debug'
    default:
      return 'log-line-other'
  }
}

/** Tail viewer for GET /v1/logs. Remount (key) when the source list changes. */
export function LogViewer({ sources }: Props) {
  const [source, setSource] = useState(sources[0]?.id ?? 'system')
  const [tail, setTail] = useState(200)
  const [data, setData] = useState<LogTailData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [auto, setAuto] = useState(false)
  const [paused, setPaused] = useState(false)
  const [follow, setFollow] = useState(true)
  const [wrap, setWrap] = useState(true)
  const [query, setQuery] = useState('')
  const [levelFilter, setLevelFilter] = useState<Set<LogLevel>>(() => new Set(LEVELS))
  const [copied, setCopied] = useState(false)
  const parentRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await apiGet<ApiEnvelope<LogTailData>>(
        `/v1/logs?source=${encodeURIComponent(source)}&tail=${tail}`,
      )
      setData(r.data)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [source, tail])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!auto || paused) return
    const t = window.setInterval(() => void load(), 5000)
    return () => window.clearInterval(t)
  }, [auto, paused, load])

  const lines = useMemo(() => {
    const text = data?.text ?? ''
    if (!text) return [] as LogRow[]
    const q = query.trim().toLowerCase()
    return text
      .split('\n')
      .map((line, i) => ({ n: i + 1, text: line, level: detectLevel(line) }))
      .filter((row) => levelFilter.has(row.level))
      .filter((row) => !q || row.text.toLowerCase().includes(q))
  }, [data?.text, query, levelFilter])

  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 22,
    overscan: 24,
  })

  useEffect(() => {
    virtualizer.measure()
  }, [wrap, lines, virtualizer])

  useEffect(() => {
    if (!follow || !lines.length) return
    const last = lines.length - 1
    virtualizer.scrollToIndex(last, { align: 'end' })
  }, [lines, follow, virtualizer])

  function toggleLevel(level: LogLevel) {
    setLevelFilter((prev) => {
      const next = new Set(prev)
      if (next.has(level)) {
        if (next.size > 1) next.delete(level)
      } else {
        next.add(level)
      }
      return next
    })
  }

  async function copyVisible() {
    const text = lines.map((l) => l.text).join('\n')
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      /* ignore */
    }
  }

  const fallbackNote =
    data && source.startsWith('plugin:') && data.path.replace(/\\/g, '/').endsWith('logs/system.log')
      ? 'У модуля нет собственного лога — показан общий system.log.'
      : ''

  return (
    <div className="stack-sm">
      <div className="row-between">
        <div
          className="row"
          role={sources.length > 1 ? 'tablist' : undefined}
          aria-label={sources.length > 1 ? 'Источник лога' : undefined}
        >
          {sources.length > 1 &&
            sources.map((s) => (
              <Button
                key={s.id}
                aria-selected={source === s.id}
                onClick={() => setSource(s.id)}
                role="tab"
                size="sm"
                type="button"
                variant={source === s.id ? 'default' : 'secondary'}
              >
                {s.label}
              </Button>
            ))}
          {data && (
            <span className="hint mono">
              {data.path}
              {!data.exists && ' (файла пока нет)'}
            </span>
          )}
        </div>
        <div className="row">
          <label className="row hint" style={{ gap: 6, cursor: 'pointer' }}>
            <input
              checked={auto}
              disabled={paused}
              onChange={(e) => setAuto(e.target.checked)}
              type="checkbox"
            />
            авто 5 с
          </label>
          <select
            aria-label="Строк"
            className="select"
            onChange={(e) => setTail(Number(e.target.value))}
            style={{ width: 'auto', padding: '0.3rem 0.6rem' }}
            value={tail}
          >
            {TAIL_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n} строк
              </option>
            ))}
          </select>
          <Button disabled={loading} onClick={() => void load()} size="sm" type="button" variant="secondary">
            <RefreshCw aria-hidden size={13} style={loading ? { animation: 'spin 1s linear infinite' } : undefined} />
            Обновить
          </Button>
        </div>
      </div>

      <div className="row-between log-toolbar">
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          <input
            aria-label="Фильтр по тексту"
            className="input"
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Фильтр…"
            style={{ width: 160, minHeight: 32, padding: '0.25rem 0.5rem' }}
            value={query}
          />
          {LEVELS.map((lv) => (
            <Button
              key={lv}
              aria-pressed={levelFilter.has(lv)}
              className={levelFilter.has(lv) ? undefined : 'opacity-50'}
              onClick={() => toggleLevel(lv)}
              size="sm"
              type="button"
              variant={levelFilter.has(lv) ? 'secondary' : 'ghost'}
            >
              {lv}
            </Button>
          ))}
        </div>
        <div className="row">
          <Button
            aria-pressed={paused}
            onClick={() => setPaused((v) => !v)}
            size="sm"
            title={paused ? 'Продолжить авто-опрос' : 'Пауза авто-опроса'}
            type="button"
            variant={paused ? 'warn' : 'secondary'}
          >
            {paused ? <Play size={13} /> : <Pause size={13} />}
            {paused ? 'Продолжить' : 'Пауза'}
          </Button>
          <Button
            aria-pressed={follow}
            onClick={() => setFollow((v) => !v)}
            size="sm"
            title="Следить за хвостом"
            type="button"
            variant={follow ? 'default' : 'secondary'}
          >
            <ArrowDownToLine size={13} />
            Хвост
          </Button>
          <Button
            aria-pressed={wrap}
            onClick={() => setWrap((v) => !v)}
            size="sm"
            title="Перенос строк"
            type="button"
            variant={wrap ? 'secondary' : 'ghost'}
          >
            <WrapText size={13} />
            Перенос
          </Button>
          <Button disabled={!lines.length} onClick={() => void copyVisible()} size="sm" type="button" variant="secondary">
            <Copy size={13} />
            {copied ? 'Скопировано' : 'Копировать'}
          </Button>
        </div>
      </div>

      {error && <InlineFeedback tone="error">{error}</InlineFeedback>}
      {fallbackNote && <InlineFeedback tone="info">{fallbackNote}</InlineFeedback>}
      {loading && !data ? (
        <Skeleton className="log-view" style={{ height: '52vh', minHeight: 240 }} />
      ) : (
        <div
          aria-busy={loading}
          aria-live="polite"
          className={`log-view log-view-virtual${wrap ? '' : ' log-view-nowrap'}`}
          onScroll={() => {
            const el = parentRef.current
            if (!el || !follow) return
            const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48
            if (!nearBottom) setFollow(false)
          }}
          ref={parentRef}
        >
          {!lines.length ? (
            <span className="hint">
              {data ? (data.exists ? '(пусто или отфильтровано)' : '(лог ещё не создан)') : '—'}
            </span>
          ) : (
            <div
              style={{
                height: `${virtualizer.getTotalSize()}px`,
                width: '100%',
                position: 'relative',
              }}
            >
              {virtualizer.getVirtualItems().map((item) => {
                const row = lines[item.index]
                return (
                  <div
                    className={`log-line ${levelClass(row.level)}`}
                    data-index={item.index}
                    key={item.key}
                    ref={virtualizer.measureElement}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${item.start}px)`,
                    }}
                  >
                    <span className="log-line-num tabular-nums">{row.n}</span>
                    <span className="log-line-text">{row.text || ' '}</span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
      <p className="hint tabular-nums">
        {lines.length} строк
        {paused ? ' · пауза' : ''}
        {follow ? ' · хвост' : ''}
      </p>
    </div>
  )
}
