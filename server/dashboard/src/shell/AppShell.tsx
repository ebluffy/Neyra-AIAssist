import { useEffect, useState } from 'react'
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import {
  BookOpenText,
  Brain,
  Cpu,
  Gauge,
  LogOut,
  Menu,
  PlugZap,
  Server,
  Settings,
  Webhook,
  X,
} from 'lucide-react'
import { apiGet, getSessionToken } from '../api'
import type { ApiEnvelope } from '../api'
import { clearDashboardGateKey } from './DashboardAuthGate'
import { DocsScreen } from '../screens/DocsScreen'
import { MemoryScreen } from '../screens/MemoryScreen'
import { ModulesScreen } from '../screens/ModulesScreen'
import { SettingsScreen } from '../screens/SettingsScreen'
import { StatusScreen } from '../screens/StatusScreen'
import { SystemScreen } from '../screens/SystemScreen'
import { WebhooksScreen } from '../screens/WebhooksScreen'
import { ErrorBoundary } from '../components/ErrorBoundary'

const NAV = [
  { to: '/status', label: 'Статус', icon: Gauge },
  { to: '/modules', label: 'Модули', icon: PlugZap },
  { to: '/memory', label: 'Память', icon: Brain },
  { to: '/system', label: 'Система', icon: Server },
  { to: '/webhooks', label: 'Вебхуки', icon: Webhook },
  { to: '/settings', label: 'Настройки', icon: Settings },
  { to: '/api-docs', label: 'Документация', icon: BookOpenText },
]

/** Web-only shell (gate + browser session). Screens below are portable to desktop. */
export function AppShell() {
  const [open, setOpen] = useState(false)
  const [mobile, setMobile] = useState(false)
  const [apiVersion, setApiVersion] = useState<string>('')
  const location = useLocation()

  useEffect(() => {
    const check = () => setMobile(window.innerWidth < 768)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  useEffect(() => {
    if (!mobile) setOpen(false)
  }, [mobile])

  useEffect(() => {
    setOpen(false)
  }, [location.pathname])

  useEffect(() => {
    if (!open || !mobile) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [open, mobile])

  useEffect(() => {
    const item = NAV.find((n) => location.pathname === n.to || location.pathname.startsWith(`${n.to}/`))
    document.title = item ? `${item.label} · Neyra` : 'Neyra — дашборд'
  }, [location.pathname])

  useEffect(() => {
    void (async () => {
      try {
        const r = await apiGet<ApiEnvelope<{ api_version?: string; version?: string }>>('/v1/meta')
        setApiVersion(String(r.data.api_version ?? r.data.version ?? ''))
      } catch {
        setApiVersion('')
      }
    })()
  }, [])

  async function logout() {
    if (!window.confirm('Выйти из панели? Потребуется снова ввести ключ доступа.')) return
    const tok = getSessionToken().trim()
    if (tok) {
      try {
        await fetch('/v1/dashboard/auth/logout', {
          method: 'POST',
          headers: { Accept: 'application/json', Authorization: `Bearer ${tok}` },
        })
      } catch {
        // best-effort
      }
    }
    clearDashboardGateKey()
    window.location.assign('/')
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        К содержимому
      </a>
      {mobile && (
        <button
          aria-expanded={open}
          aria-label="Открыть меню"
          className="mobile-toggle"
          onClick={() => setOpen(true)}
          type="button"
        >
          <Menu size={20} />
        </button>
      )}
      {mobile && open && <div aria-hidden className="mobile-overlay" onClick={() => setOpen(false)} />}

      <aside className={`sidebar${open ? ' open' : ''}`} aria-label="Навигация">
        <div className="sidebar-logo">
          <div className="sidebar-logo-icon" aria-hidden>
            <Cpu size={18} color="#fff" />
          </div>
          <div className="sidebar-logo-text">
            <span className="sidebar-logo-name">Neyra</span>
            <span className="sidebar-logo-sub">Панель управления</span>
          </div>
          {mobile && (
            <button
              aria-label="Закрыть меню"
              onClick={() => setOpen(false)}
              style={{
                marginLeft: 'auto',
                background: 'none',
                border: 'none',
                color: 'var(--muted)',
                cursor: 'pointer',
                padding: '0.5rem',
                minWidth: 44,
                minHeight: 44,
              }}
              type="button"
            >
              <X size={18} />
            </button>
          )}
        </div>

        <nav className="sidebar-nav">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
              onClick={() => setOpen(false)}
              to={to}
            >
              <Icon aria-hidden className="nav-item-icon" size={18} />
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer">
          <button className="sidebar-logout" onClick={() => void logout()} type="button">
            <LogOut size={14} aria-hidden />
            Выйти
          </button>
          <span>{apiVersion ? `API ${apiVersion}` : '…'}</span>
        </div>
      </aside>

      <main className="main-area" id="main-content" tabIndex={-1}>
        <ErrorBoundary>
          <Routes>
            <Route element={<Navigate replace to="/status" />} path="/" />
            <Route element={<Navigate replace to="/status" />} path="/home" />
            <Route element={<Navigate replace to="/status" />} path="/dashboard" />
            <Route element={<Navigate replace to="/modules" />} path="/plugins" />
            <Route element={<StatusScreen />} path="/status" />
            <Route element={<ModulesScreen />} path="/modules" />
            <Route element={<MemoryScreen />} path="/memory" />
            <Route element={<SystemScreen />} path="/system" />
            <Route element={<WebhooksScreen />} path="/webhooks" />
            <Route element={<SettingsScreen />} path="/settings" />
            <Route element={<DocsScreen />} path="/api-docs" />
            <Route element={<Navigate replace to="/status" />} path="*" />
          </Routes>
        </ErrorBoundary>
      </main>
    </div>
  )
}
