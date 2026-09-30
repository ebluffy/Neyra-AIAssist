import { useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Cpu, KeyRound, Lock, RefreshCw } from 'lucide-react'
import { Button } from './ui/button'

const GATE_KEY = 'neyra_dashboard_gate'
const MIN_LEN = 8

export function getDashboardGateKey(): string {
  return sessionStorage.getItem(GATE_KEY) ?? ''
}

export function setDashboardGateKey(key: string): void {
  const s = key.trim()
  if (s) sessionStorage.setItem(GATE_KEY, s)
  else sessionStorage.removeItem(GATE_KEY)
}

export function clearDashboardGateKey(): void {
  sessionStorage.removeItem(GATE_KEY)
}

function generateHexKey(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

type Mode = 'loading' | 'setup' | 'login' | 'ok'

async function fetchStatus(): Promise<boolean> {
  const r = await fetch('/v1/dashboard/auth/status', { headers: { Accept: 'application/json' } })
  const j = (await r.json()) as { ok?: boolean; data?: { configured?: boolean }; error?: { message?: string } }
  if (!r.ok || j.ok === false) {
    throw new Error(j.error?.message || `HTTP ${r.status}`)
  }
  return Boolean(j.data?.configured)
}

async function postKey(path: string, key: string): Promise<void> {
  const r = await fetch(path, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  })
  const j = (await r.json()) as { ok?: boolean; error?: { message?: string } }
  if (!r.ok || j.ok === false) {
    throw new Error(j.error?.message || `HTTP ${r.status}`)
  }
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
        const saved = getDashboardGateKey()
        if (!saved) {
          setMode('login')
          return
        }
        try {
          await postKey('/v1/dashboard/auth/login', saved)
          if (!cancelled) setMode('ok')
        } catch {
          clearDashboardGateKey()
          if (!cancelled) setMode('login')
        }
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
      await postKey('/v1/dashboard/auth/setup', key)
      setDashboardGateKey(key)
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
      await postKey('/v1/dashboard/auth/login', key)
      setDashboardGateKey(key)
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
          {/* Helps password managers bind a site login */}
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
              placeholder={isSetup ? 'минимум 8 символов или Generate' : 'ключ доступа'}
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
          <Button disabled={busy || key.trim().length < MIN_LEN} type="submit">
            {busy ? '…' : isSetup ? 'Создать и войти' : 'Войти'}
          </Button>
        </form>
        <p className="dash-auth-hint">
          {isSetup
            ? 'Минимум 8 символов. На диске сервера хранится только хеш (PBKDF2). В браузере ключ держится в sessionStorage до «Выйти» — сохраните его в менеджере паролей.'
            : 'На сервере — только хеш. В этой вкладке ключ в sessionStorage до выхода.'}
        </p>
      </div>
    </div>
  )
}
