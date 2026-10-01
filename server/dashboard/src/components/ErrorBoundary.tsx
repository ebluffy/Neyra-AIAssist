import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from './ui/button'

type Props = { children: ReactNode }
type State = { error: Error | null }

/** Catches render crashes so the shell does not go blank. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('dashboard render error', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="page-content stack" role="alert">
        <h1 style={{ fontSize: '1.25rem', fontWeight: 600 }}>Что-то сломалось на экране</h1>
        <p style={{ color: 'var(--muted)', fontSize: '0.9rem', lineHeight: 1.5 }}>
          Ошибка рендера. Можно обновить страницу или вернуться на статус — данные на сервере не трогались.
        </p>
        <pre className="code-block" style={{ maxHeight: 160, overflow: 'auto' }}>
          {this.state.error.message}
        </pre>
        <div className="row">
          <Button onClick={() => window.location.assign('/status')} type="button">
            На статус
          </Button>
          <Button onClick={() => window.location.reload()} type="button" variant="secondary">
            Обновить
          </Button>
        </div>
      </div>
    )
  }
}
