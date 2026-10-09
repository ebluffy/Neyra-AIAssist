import { useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Copy, Cpu, Eye, EyeOff, KeyRound, Lock, RefreshCw } from 'lucide-react'
import { clearSessionToken, hasDashboardSession, setSessionToken } from '../api'
import { Button } from '../components/ui/button'
import { Skeleton } from '../components/ui/skeleton'
import { toast } from 'sonner'

const MIN_LEN = 32

function isBrowserLocalHost(): boolean {
  if (typeof window === 'undefined') return true
  const h = (window.location.hostname || '').toLowerCase()
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1'
}

function clearDashboardGateKey(): void {
  clearSessionToken()
}

function generateHexKey(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

type Mode = 'loading' | 'setup' | 'setup_remote_blocked' | 'login' | 'ok'

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
}

export function DashboardAuthGate({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<Mode>('loading')
  const [key, setKey] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [capsOn, setCapsOn] = useState(false)
  const [savedOk, setSavedOk] = useState(false)

  useEffect(() => {
    document.title =
      mode === 'setup' || mode === 'setup_remote_blocked'
        ? 'Первичная настройка · Neyra'
        : mode === 'login'
          ? 'Вход · Neyra'
          : mode === 'loading'
            ? 'Вход · Neyra'
            : document.title
  }, [mode])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const configured = await fetchStatus()
        if (cancelled) return
        if (!configured) {
          // Public host cannot complete first setup from the SPA (needs console-local or API_TOKEN).
          setMode(isBrowserLocalHost() ? 'setup' : 'setup_remote_blocked')
          return
        }
        if (hasDashboardSession()) {
          // Revalidate session — revoked/expired tokens must not unlock the shell.
          try {
            const tok = sessionStorage.getItem('neyra_dashboard_session')?.trim()
            const r = await fetch('/v1/meta', {
              headers: {
                Accept: 'application/json',
                ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
              },
            })
            if (r.status === 401) {
              clearDashboardGateKey()
              setMode('login')
              return
            }
          } catch {
            // network blip: still allow shell; first API call will fail loudly
          }
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
      const msg = err instanceof Error ? err.message : String(err)
      if (/403|forbidden|localhost|Bearer|API/i.test(msg)) {
        setError(
          `${msg} С публичного URL первый ключ создаётся на сервере (консоль / curl + API_TOKEN), не из этой формы.`,
        )
      } else {
        setError(msg)
      }
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
        <div aria-busy="true" aria-live="polite" className="dash-auth-card">
          <div className="dash-auth-brand">
            <div aria-hidden className="dash-auth-icon">
              <Cpu size={20} strokeWidth={1.75} />
            </div>
            <div className="dash-auth-loading" style={{ flex: 1 }}>
              <Skeleton className="h-5" style={{ width: '40%' }} />
              <Skeleton className="h-3" style={{ width: '55%' }} />
            </div>
          </div>
          <Skeleton className="h-10" />
          <p className="dash-auth-muted">Проверка доступа…</p>
        </div>
      </div>
    )
  }

  if (mode === 'setup_remote_blocked') {
    return (
      <div className="dash-auth">
        <div className="dash-auth-card">
          <div className="dash-auth-brand">
            <div aria-hidden className="dash-auth-icon">
              <Cpu size={20} strokeWidth={1.75} />
            </div>
            <div>
              <h1 className="dash-auth-title">Neyra</h1>
              <p className="dash-auth-sub">Панель управления</p>
            </div>
          </div>
          <p className="dash-auth-lead">
            Ключ доступа ещё не создан. С публичного URL первый setup из браузера недоступен (защита от удалённого
            bootstrap).
          </p>
          <p className="dash-auth-hint">
            Создай ключ на сервере: локальная консоль к API (без CF/X-Real) или{' '}
            <code className="inline-code">curl</code> с primary{' '}
            <code className="inline-code">API_TOKEN</code> на{' '}
            <code className="inline-code">POST /v1/dashboard/auth/setup</code>. После этого обнови
            страницу и войди этим ключом.
          </p>
          <Button
            disabled={busy}
            onClick={() => {
              setBusy(true)
              void fetchStatus()
                .then((configured) => {
                  if (configured) setMode('login')
                  else setError('Ключ всё ещё не задан на сервере')
                })
                .catch((e) => setError(e instanceof Error ? e.message : String(e)))
                .finally(() => setBusy(false))
            }}
            type="button"
          >
            {busy ? '…' : 'Проверить снова'}
          </Button>
          {error && <p className="dash-auth-error">{error}</p>}
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
            <Cpu size={20} strokeWidth={1.75} />
          </div>
          <div>
            <h1 className="dash-auth-title">Neyra</h1>
            <p className="dash-auth-sub">Панель управления</p>
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
            <div className="dash-auth-input-row">
              <input
                autoComplete={isSetup ? 'new-password' : 'current-password'}
                autoFocus
                className="dash-auth-input"
                name="password"
                onChange={(ev) => setKey(ev.target.value)}
                onKeyUp={(ev) => setCapsOn(ev.getModifierState?.('CapsLock') ?? false)}
                placeholder={isSetup ? 'минимум 32 символа или «Сгенерировать»' : 'ключ доступа'}
                type={showKey ? 'text' : 'password'}
                value={key}
              />
              <button
                aria-label={showKey ? 'Скрыть ключ' : 'Показать ключ'}
                className="dash-auth-eye"
                onClick={() => setShowKey((v) => !v)}
                type="button"
              >
                {showKey ? <EyeOff aria-hidden size={16} strokeWidth={1.75} /> : <Eye aria-hidden size={16} strokeWidth={1.75} />}
              </button>
            </div>
          </label>
          {capsOn ? <p className="dash-auth-caps">Включён Caps Lock</p> : null}
          <p className="dash-auth-len tabular-nums" aria-live="polite">
            Длина: {key.trim().length}
            {key.trim().length > 0 && key.trim().length < MIN_LEN ? ` (нужно ≥ ${MIN_LEN})` : ''}
          </p>
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
                  type={showKey ? 'text' : 'password'}
                  value={confirm}
                />
              </label>
              <div className="row" style={{ gap: '0.5rem' }}>
                <Button
                  className="dash-auth-generate"
                  disabled={busy}
                  onClick={fillGenerated}
                  type="button"
                  variant="secondary"
                >
                  <RefreshCw size={14} />
                  Сгенерировать (64 hex)
                </Button>
                <Button
                  disabled={!key}
                  onClick={() => {
                    void navigator.clipboard.writeText(key).then(
                      () => toast.success('Ключ скопирован'),
                      () => toast.error('Не удалось скопировать'),
                    )
                  }}
                  type="button"
                  variant="ghost"
                >
                  <Copy size={14} />
                  Копировать
                </Button>
              </div>
              <label className="dash-auth-check">
                <input checked={savedOk} onChange={(e) => setSavedOk(e.target.checked)} type="checkbox" />
                Я сохранил ключ
              </label>
            </>
          )}
          {error && <p className="dash-auth-error">{error}</p>}
          <Button
            disabled={
              busy ||
              (isSetup
                ? key.trim().length < MIN_LEN || key.trim() !== confirm.trim() || !savedOk
                : key.trim().length < 8)
            }
            type="submit"
          >
            {busy ? '…' : isSetup ? 'Создать и войти' : 'Войти'}
          </Button>
        </form>
        <p className="dash-auth-hint">
          {isSetup
            ? 'Минимум 32 символа. На диске сервера — только хеш (PBKDF2). Локальный setup — с этой машины к API без прокси-заголовков. С публичного URL первый ключ — только через консоль сервера или curl + API_TOKEN.'
            : 'После входа API ходит с session-токеном (не с сырым ключом). Токен в sessionStorage до выхода / закрытия вкладки.'}
        </p>
      </div>
    </div>
  )
}
