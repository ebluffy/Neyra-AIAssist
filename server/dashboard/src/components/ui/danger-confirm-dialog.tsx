import { useEffect, useId, useRef, useState } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { cn } from '@/lib/utils'

type Props = {
  open: boolean
  title: string
  description: string
  /** Phrase the user must type to enable confirm. Empty = click-to-confirm (unsaved nav). */
  confirmPhrase?: string
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
  confirmPhrase = '',
  confirmLabel = 'Подтвердить',
  cancelLabel = 'Отмена',
  busy = false,
  onConfirm,
  onCancel,
}: Props) {
  const [typed, setTyped] = useState('')
  const [wasOpen, setWasOpen] = useState(open)
  const inputRef = useRef<HTMLInputElement>(null)
  const phraseId = useId()
  const needsPhrase = Boolean(confirmPhrase && confirmPhrase.length > 0)
  const match = !needsPhrase || typed.trim() === confirmPhrase

  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setTyped('')
  }

  useEffect(() => {
    if (!open || !needsPhrase) return
    const t = window.setTimeout(() => inputRef.current?.focus(), 40)
    return () => window.clearTimeout(t)
  }, [open, needsPhrase])

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onCancel()
      }}
    >
      <AlertDialogContent
        className={cn(
          'border-[var(--border-hi)] bg-[var(--surface)] text-[var(--text)] shadow-[var(--shadow-border)]',
          needsPhrase && 'border-t-4 border-t-[var(--danger)]',
        )}
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="text-[var(--text)] text-wrap-balance">{title}</AlertDialogTitle>
          <AlertDialogDescription className="text-[var(--muted)]">{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {needsPhrase ? (
          <label className="label" htmlFor={phraseId}>
            <span className="label-text">
              Введите <span className="inline-code">{confirmPhrase}</span>
            </span>
            <input
              id={phraseId}
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
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy} onClick={onCancel}>
            {cancelLabel}
          </AlertDialogCancel>
          <AlertDialogAction
            className={cn(!match || busy ? 'pointer-events-none opacity-50' : '', 'btn-danger')}
            disabled={!match || busy}
            onClick={(e) => {
              e.preventDefault()
              if (match && !busy) onConfirm()
            }}
          >
            {busy ? '…' : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
