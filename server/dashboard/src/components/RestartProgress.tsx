import { Loader2 } from 'lucide-react'

type Step = 'stop' | 'offline' | 'online' | 'error'

type Props = {
  step: Step
  message?: string
  elapsedSec?: number
}

const LABELS: Record<Step, string> = {
  stop: 'Остановка…',
  offline: 'Offline — ждём подъём…',
  online: 'Online',
  error: 'Ошибка рестарта',
}

export function RestartProgress({ step, message, elapsedSec }: Props) {
  const steps: Step[] = ['stop', 'offline', 'online']
  return (
    <div className="card" aria-live="polite">
      <div className="card-header">
        <Loader2
          aria-hidden
          className={step === 'online' || step === 'error' ? undefined : 'spin'}
          size={15}
          style={step !== 'online' && step !== 'error' ? { animation: 'spin 1s linear infinite' } : undefined}
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
