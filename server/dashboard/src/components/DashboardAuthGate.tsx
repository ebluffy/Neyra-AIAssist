import { useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Cpu, KeyRound, Lock } from 'lucide-react'
import { Button } from './ui/button'

const GATE_KEY = 'neyra_dashboard_gate'

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

  async function onSetup(e: FormEvent) {
    e.preventDefault()
    setError('')
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
            ? 'Первый вход: придумайте ключ доступа к дашборду. Он будет спрашиваться при каждом открытии.'
            : 'Введите ключ доступа к дашборду.'}
        </p>

        <form className="dash-auth-form" onSubmit={isSetup ? onSetup : onLogin}>
          <label className="dash-auth-label">
            <KeyRound size={14} />
            Ключ доступа
            <input
              autoComplete={isSetup ? 'new-password' : 'current-password'}
              autoFocus
              className="dash-auth-input"
              onChange={(ev) => setKey(ev.target.value)}
              placeholder="например 12345678"
              type="password"
              value={key}
            />
          </label>
          {isSetup && (
            <label className="dash-auth-label">
              <Lock size={14} />
              Повторите ключ
              <input
                autoComplete="new-password"
                className="dash-auth-input"
                onChange={(ev) => setConfirm(ev.target.value)}
                type="password"
                value={confirm}
              />
            </label>
          )}
          {error && <p className="dash-auth-error">{error}</p>}
          <Button disabled={busy || key.trim().length < 4} type="submit">
            {busy ? '…' : isSetup ? 'Создать ключ' : 'Войти'}
          </Button>
        </form>
        <p className="dash-auth-hint">Минимум 4 символа. Ключ хранится только на сервере (хеш в SQLite).</p>
      </div>
    </div>
  )
}
