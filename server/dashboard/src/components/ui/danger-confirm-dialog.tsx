import { useEffect, useId, useRef, useState } from 'react'
import { Button } from './button'

type Props = {
  open: boolean
  title: string
  description: string
  /** Phrase the user must type to enable confirm. */
  confirmPhrase: string
  confirmLabel?: string
  cancelLabel?: string
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function DangerConfirmDialog({
  open,
  title,
  description,
  confirmPhrase,
  confirmLabel = 'Подтвердить',
  cancelLabel = 'Отмена',
  busy = false,
  onConfirm,
  onCancel,
}: Props) {
  const [typed, setTyped] = useState('')
  const [wasOpen, setWasOpen] = useState(open)
  const inputRef = useRef<HTMLInputElement>(null)
  const titleId = useId()
  const descId = useId()
  const match = typed.trim() === confirmPhrase

  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setTyped('')
  }

  useEffect(() => {
    if (!open) return
    const t = window.setTimeout(() => inputRef.current?.focus(), 40)
    return () => window.clearTimeout(t)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, busy, onCancel])

  if (!open) return null

  return (
    <div
      aria-labelledby={titleId}
      aria-describedby={descId}
      aria-modal="true"
      className="danger-dialog-overlay"
      role="dialog"
    >
      <div className="danger-dialog-card">
        <h2 className="page-title" id={titleId} style={{ fontSize: '1.1rem', marginBottom: '0.5rem' }}>
          {title}
        </h2>
        <p className="page-sub" id={descId} style={{ marginBottom: '1rem' }}>
          {description}
        </p>
        <label className="label">
          <span className="label-text">
            Введите <span className="inline-code">{confirmPhrase}</span>
          </span>
          <input
            ref={inputRef}
            autoComplete="off"
            className="input input-mono"
            disabled={busy}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && match && !busy) onConfirm()
            }}
            spellCheck={false}
            value={typed}
          />
        </label>
        <div className="row" style={{ marginTop: '1rem', justifyContent: 'flex-end' }}>
          <Button disabled={busy} onClick={onCancel} type="button" variant="secondary">
            {cancelLabel}
          </Button>
          <Button disabled={!match || busy} onClick={onConfirm} type="button" variant="danger">
            {busy ? '…' : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}
