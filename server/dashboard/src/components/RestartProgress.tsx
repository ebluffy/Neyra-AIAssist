import { CheckCircle2, Loader2, XCircle } from 'lucide-react'

type Step = 'stop' | 'offline' | 'online' | 'error'

type Props = {
  step: Step
  message?: string
  elapsedSec?: number
}

const LABELS: Record<Exclude<Step, 'error'>, string> = {
  stop: 'Остановка…',
  offline: 'Offline — ждём подъём…',
  online: 'Online',
}

export function RestartProgress({ step, message, elapsedSec }: Props) {
  const steps: Array<Exclude<Step, 'error'>> = ['stop', 'offline', 'online']
  const Icon = step === 'online' ? CheckCircle2 : step === 'error' ? XCircle : Loader2
  const spinning = step === 'stop' || step === 'offline'
  return (
    <div className="card" aria-live="polite">
      <div className="card-header">
        <Icon
          aria-hidden
          color={step === 'online' ? 'var(--emerald)' : step === 'error' ? 'var(--danger)' : undefined}
          size={15}
          style={spinning ? { animation: 'spin 1s linear infinite' } : undefined}
        />
        <span className="card-title">Мягкий перезапуск</span>
        {elapsedSec != null ? <span className="hint tabular-nums">{elapsedSec} с</span> : null}
      </div>
      <ol className="restart-steps">
        {steps.map((s) => {
          const idx = steps.indexOf(s)
          const cur = steps.indexOf(step === 'error' ? 'offline' : step)
          const done = idx < cur || step === 'online'
          const active = s === step || (step === 'error' && s === 'offline')
          return (
            <li className={`restart-step${done ? ' done' : ''}${active ? ' active' : ''}`} key={s}>
              {LABELS[s]}
            </li>
          )
        })}
      </ol>
      {message ? <p className="page-sub">{message}</p> : null}
    </div>
  )
}
