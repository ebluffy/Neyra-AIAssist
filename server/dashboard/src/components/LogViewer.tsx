import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { apiGet } from '../api'
import type { ApiEnvelope, LogTailData } from '../api'
import { Button } from './ui/button'
import { InlineFeedback } from './ui/inline-feedback'

export type LogSource = { id: string; label: string }

type Props = {
  sources: LogSource[]
}

const TAIL_OPTIONS = [100, 200, 500, 1000, 2000]

/** Tail viewer for GET /v1/logs. Remount (key) when the source list changes. */
export function LogViewer({ sources }: Props) {
  const [source, setSource] = useState(sources[0]?.id ?? 'system')
  const [tail, setTail] = useState(200)
  const [data, setData] = useState<LogTailData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [auto, setAuto] = useState(false)
  const boxRef = useRef<HTMLPreElement>(null)

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
    if (!auto) return
    const t = window.setInterval(() => void load(), 5000)
    return () => window.clearInterval(t)
  }, [auto, load])

  useEffect(() => {
    const el = boxRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [data])

  const fallbackNote =
    data && source.startsWith('plugin:') && data.path.replace(/\\/g, '/').endsWith('logs/system.log')
      ? 'У модуля нет собственного лога — показан общий system.log.'
      : ''

  return (
    <div className="stack-sm">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="row">
          {sources.length > 1 &&
            sources.map((s) => (
              <Button
                key={s.id}
                onClick={() => setSource(s.id)}
                size="sm"
                type="button"
                variant={source === s.id ? 'default' : 'secondary'}
              >
                {s.label}
              </Button>
            ))}
          {data && (
            <span className="hint" style={{ fontFamily: 'var(--mono)' }}>
              {data.path}
              {!data.exists && ' (файла пока нет)'}
            </span>
          )}
        </div>
        <div className="row">
          <label className="row" style={{ gap: 6, fontSize: '0.78rem', color: 'var(--muted)' }}>
            <input checked={auto} onChange={(e) => setAuto(e.target.checked)} type="checkbox" />
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
            <RefreshCw size={13} style={loading ? { animation: 'spin 1s linear infinite' } : undefined} />
            Обновить
          </Button>
        </div>
      </div>
      {error && <InlineFeedback tone="error">{error}</InlineFeedback>}
      {fallbackNote && <InlineFeedback tone="info">{fallbackNote}</InlineFeedback>}
      <pre className="log-view" ref={boxRef}>
        {data ? data.text || (data.exists ? '(пусто)' : '(лог ещё не создан)') : loading ? 'Загрузка…' : '—'}
      </pre>
    </div>
  )
}
