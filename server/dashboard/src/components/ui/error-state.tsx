import { AlertTriangle, Copy, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { ApiRequestError } from '../../api'
import { Button } from './button'

type Props = {
  error: unknown
  onRetry?: () => void
  title?: string
}

function describe(error: unknown): { message: string; code: string; traceId: string } {
  if (error instanceof ApiRequestError) {
    return {
      message: error.message,
      code: error.code,
      traceId: error.trace_id,
    }
  }
  if (error instanceof Error) {
    return { message: error.message, code: '', traceId: '' }
  }
  return { message: String(error ?? 'Ошибка'), code: '', traceId: '' }
}

export function ErrorState({ error, onRetry, title = 'Ошибка' }: Props) {
  const { message, code, traceId } = describe(error)
  const [copied, setCopied] = useState(false)
  const meta = [code && `code=${code}`, traceId && `trace_id=${traceId}`].filter(Boolean).join(' · ')

  async function copyTrace() {
    const text = [message, code && `code: ${code}`, traceId && `trace_id: ${traceId}`]
      .filter(Boolean)
      .join('\n')
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="empty-state" role="alert">
      <div className="empty-state-icon" aria-hidden>
        <AlertTriangle size={22} strokeWidth={1.75} />
      </div>
      <p className="empty-state-title">{title}</p>
      <p className="empty-state-desc">{message}</p>
      {meta ? (
        <p className="mono" style={{ color: 'var(--muted)', fontSize: '0.72rem' }}>
          {meta}
        </p>
      ) : null}
      <div className="row" style={{ justifyContent: 'center', marginTop: '0.35rem' }}>
        {onRetry ? (
          <Button onClick={onRetry} size="sm" type="button" variant="secondary">
            <RefreshCw size={14} aria-hidden />
            Повторить
          </Button>
        ) : null}
        {(code || traceId) && (
          <Button onClick={() => void copyTrace()} size="sm" type="button" variant="secondary">
            <Copy size={14} aria-hidden />
            {copied ? 'Скопировано' : 'Копировать'}
          </Button>
        )}
      </div>
    </div>
  )
}
