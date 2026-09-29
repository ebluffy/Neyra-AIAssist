import { AlertCircle, CheckCircle2, Info } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'

type Tone = 'error' | 'success' | 'info'

const cls: Record<Tone, string> = {
  error:   'feedback feedback-error',
  success: 'feedback feedback-success',
  info:    'feedback feedback-info',
}
const Icon = { error: AlertCircle, success: CheckCircle2, info: Info } satisfies Record<Tone, typeof Info>

export function InlineFeedback({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string }) {
  const I = Icon[tone]
  return (
    <div className={cn(cls[tone], className)}>
      <I size={16} style={{ marginTop: 2, flexShrink: 0 }} />
      <div>{children}</div>
    </div>
  )
}
