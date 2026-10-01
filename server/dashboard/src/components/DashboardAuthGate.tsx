import { useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Cpu, KeyRound, Lock, RefreshCw } from 'lucide-react'
import { clearToken, getToken, setSessionToken } from '../api'
import { Button } from './ui/button'

const GATE_FLAG = 'neyra_dashboard_gate_ok'
const MIN_LEN = 32

export function clearDashboardGateKey(): void {
  sessionStorage.removeItem(GATE_FLAG)
  clearToken()
}

function generateHexKey(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

type Mode = 'loading' | 'setup' | 'login' | 'ok'

type AuthOk = { session_token?: string }

async function fetchStatus(): Promise<boolean> {
  const r = await fetch('/v1/dashboard/auth/status', { headers: { Accept: 'application/json' } })
  const j = (await r.json()) as { ok?: boolean; data?: { configured?: boolean }; error?: { message?: string } }
  if (!r.ok || j.ok === false) {
    throw new Error(j.error?.message || `HTTP ${r.status}`)
  }
  return Boolean(j.data?.configured)
}

async function postKey(path: string, key: string): Promise<AuthOk> {
  const r = await fetch(path, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  })
  const j = (await r.json()) as {
    ok?: boolean
    data?: AuthOk
    error?: { message?: string }
  }
  if (!r.ok || j.ok === false) {
    throw new Error(j.error?.message || `HTTP ${r.status}`)
  }
  return j.data ?? {}
}

/** Persist short-lived session Bearer in sessionStorage (same lifetime as the tab). */
function activateSession(sessionToken: string): void {
  setSessionToken(sessionToken)
  sessionStorage.setItem(GATE_FLAG, '1')
}

export function DashboardAuthGate({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<Mode>('loading')
  const [key, setKey] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const configured = await fetchStatus()
        if (cancelled) return
        if (!configured) {
          setMode('setup')
          return
        }
        // Session Bearer lives in sessionStorage; if missing — show login.
        const hasSession = Boolean(sessionStorage.getItem(GATE_FLAG))
        if (hasSession && getToken().trim()) {
          setMode('ok')
          return
        }
        clearDashboardGateKey()
        setMode('login')
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e))
          setMode('login')
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  function fillGenerated() {
    const gen = generateHexKey()
    setKey(gen)
    setConfirm(gen)
    setError('')
  }

  async function onSetup(e: FormEvent) {
    e.preventDefault()
    setError('')
    if (key.trim().length < MIN_LEN) {
      setError(`Минимум ${MIN_LEN} символов`)
      return
    }
    if (key.trim() !== confirm.trim()) {
      setError('Ключи не совпадают')
      return
    }
    setBusy(true)
    try {
      const data = await postKey('/v1/dashboard/auth/setup', key)
      if (!data.session_token) throw new Error('Сервер не выдал session_token')
      activateSession(data.session_token)
      setMode('ok')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function onLogin(e: FormEvent) {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      const data = await postKey('/v1/dashboard/auth/login', key)
      if (!data.session_token) throw new Error('Сервер не выдал session_token')
      activateSession(data.session_token)
      setMode('ok')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (mode === 'ok') return <>{children}</>

  if (mode === 'loading') {
    return (
      <div className="dash-auth">
        <div className="dash-auth-card">
          <p className="dash-auth-muted">Загрузка…</p>
        </div>
      </div>
    )
  }

  const isSetup = mode === 'setup'

  return (
    <div className="dash-auth">
      <div className="dash-auth-card">
        <div className="dash-auth-brand">
          <div className="dash-auth-icon">
            <Cpu size={20} color="#fff" />
          </div>
          <div>
            <h1 className="dash-auth-title">Neyra</h1>
            <p className="dash-auth-sub">Control Center</p>
          </div>
        </div>

        <p className="dash-auth-lead">
          {isSetup
            ? 'Первый вход: задайте ключ доступа (или сгенерируйте) и сохраните его в менеджере паролей браузера.'
            : 'Введите ключ доступа к дашборду (можно подставить из менеджера паролей).'}
        </p>

        <form
          className="dash-auth-form"
          onSubmit={isSetup ? onSetup : onLogin}
        >
          <input
            autoComplete="username"
            name="username"
            readOnly
            tabIndex={-1}
            type="text"
            value="neyra-dashboard"
            style={{ position: 'absolute', opacity: 0, height: 0, width: 0, pointerEvents: 'none' }}
            aria-hidden
          />

          <label className="dash-auth-label">
            <KeyRound size={14} />
            Ключ доступа
            <input
              autoComplete={isSetup ? 'new-password' : 'current-password'}
              autoFocus
              className="dash-auth-input"
              name="password"
              onChange={(ev) => setKey(ev.target.value)}
              placeholder={isSetup ? 'минимум 32 символа или «Сгенерировать»' : 'ключ доступа'}
              type="password"
              value={key}
            />
          </label>
          {isSetup && (
            <>
              <label className="dash-auth-label">
                <Lock size={14} />
                Повторите ключ
                <input
                  autoComplete="new-password"
                  className="dash-auth-input"
                  name="password-confirm"
                  onChange={(ev) => setConfirm(ev.target.value)}
                  type="password"
                  value={confirm}
                />
              </label>
              <Button
                className="dash-auth-generate"
                disabled={busy}
                onClick={fillGenerated}
                type="button"
                variant="secondary"
              >
                <RefreshCw size={14} />
                Сгенерировать hex (32)
              </Button>
            </>
          )}
          {error && <p className="dash-auth-error">{error}</p>}
          <Button disabled={busy || (isSetup ? key.trim().length < MIN_LEN : key.trim().length < 8)} type="submit">
            {busy ? '…' : isSetup ? 'Создать и войти' : 'Войти'}
          </Button>
        </form>
        <p className="dash-auth-hint">
          {isSetup
            ? 'Минимум 32 символа. На диске сервера — только хеш (PBKDF2). После входа браузер держит короткоживущий session-токен до закрытия вкладки или «Выйти».'
            : 'После входа API ходит с session-токеном (не с сырым ключом). Токен в sessionStorage до выхода / закрытия вкладки.'}
        </p>
      </div>
    </div>
  )
}
