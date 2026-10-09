import { useCallback, useEffect, useState } from 'react'
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import {
  BookOpenText,
  Brain,
  Cpu,
  Gauge,
  LogOut,
  Menu,
  Moon,
  PlugZap,
  Server,
  Settings,
  Sun,
  Webhook,
  X,
} from 'lucide-react'
import { apiGet, getSessionToken } from '../api'
import type { ApiEnvelope } from '../api'
import { clearDashboardGateKey } from './DashboardAuthGate'
import { allowNavigation } from '../lib/navigation-guard'
import { applyTheme, getStoredTheme, type Theme } from '../lib/theme'
import { DocsScreen } from '../screens/DocsScreen'
import { MemoryScreen } from '../screens/MemoryScreen'
import { ModulesScreen } from '../screens/ModulesScreen'
import { NotFoundScreen } from '../screens/NotFoundScreen'
import { SettingsScreen } from '../screens/SettingsScreen'
import { StatusScreen } from '../screens/StatusScreen'
import { SystemScreen } from '../screens/SystemScreen'
import { UiKitScreen } from '../screens/UiKitScreen'
import { WebhooksScreen } from '../screens/WebhooksScreen'
import { CommandPalette } from '../components/CommandPalette'
import { ConnectionBanner } from '../components/ConnectionBanner'
import { DangerConfirmDialog } from '../components/ui/danger-confirm-dialog'
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

const TITLE_MAP: Array<{ match: (p: string) => boolean; title: string }> = [
  { match: (p) => p === '/status' || p.startsWith('/status/'), title: 'Статус' },
  { match: (p) => p === '/modules' || p.startsWith('/modules/'), title: 'Модули' },
  { match: (p) => p === '/memory' || p.startsWith('/memory/'), title: 'Память' },
  { match: (p) => p === '/system' || p.startsWith('/system/'), title: 'Система' },
  { match: (p) => p === '/backups' || p.startsWith('/backups/'), title: 'Бэкапы' },
  { match: (p) => p === '/webhooks' || p.startsWith('/webhooks/'), title: 'Вебхуки' },
  { match: (p) => p === '/settings' || p.startsWith('/settings/'), title: 'Настройки' },
  { match: (p) => p === '/api-docs' || p.startsWith('/api-docs/'), title: 'Документация' },
  { match: (p) => p === '/__ui', title: 'UI kit' },
]

/** Web-only shell (gate + browser session). Screens below are portable to desktop. */
export function AppShell() {
  const [open, setOpen] = useState(false)
  const [mobile, setMobile] = useState(false)
  const [apiVersion, setApiVersion] = useState<string>('')
  const [theme, setTheme] = useState<Theme>(() => getStoredTheme())
  const [logoutOpen, setLogoutOpen] = useState(false)
  const [logoutBusy, setLogoutBusy] = useState(false)
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
    const item = TITLE_MAP.find((n) => n.match(location.pathname))
    document.title = item ? `${item.title} · Neyra` : 'Не найдено · Neyra'
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

  const doLogout = useCallback(async () => {
    setLogoutBusy(true)
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
  }, [])

  function onThemeToggle() {
    const next: Theme = theme === 'light' ? 'dark' : 'light'
    applyTheme(next)
    setTheme(next)
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
          <Menu aria-hidden size={20} strokeWidth={1.75} />
        </button>
      )}
      {mobile && open && <div aria-hidden className="mobile-overlay" onClick={() => setOpen(false)} />}

      <aside className={`sidebar${open ? ' open' : ''}`} aria-label="Навигация">
        <div className="sidebar-logo">
          <div className="sidebar-logo-icon" aria-hidden>
            <Cpu size={18} strokeWidth={1.75} />
          </div>
          <div className="sidebar-logo-text">
            <span className="sidebar-logo-name">Neyra</span>
            <span className="sidebar-logo-sub">Панель управления</span>
          </div>
          {mobile && (
            <button aria-label="Закрыть меню" className="sidebar-close" onClick={() => setOpen(false)} type="button">
              <X aria-hidden size={18} strokeWidth={1.75} />
            </button>
          )}
        </div>

        <nav className="sidebar-nav">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
              onClick={(e) => {
                if (!allowNavigation()) {
                  e.preventDefault()
                  return
                }
                setOpen(false)
              }}
              to={to}
            >
              <Icon aria-hidden className="nav-item-icon" size={18} />
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="row" style={{ gap: '0.4rem' }}>
            <button
              aria-label={theme === 'light' ? 'Тёмная тема' : 'Светлая тема'}
              className="theme-toggle"
              onClick={onThemeToggle}
              type="button"
            >
              {theme === 'light' ? (
                <Moon aria-hidden size={16} strokeWidth={1.75} />
              ) : (
                <Sun aria-hidden size={16} strokeWidth={1.75} />
              )}
            </button>
            <button
              aria-label="Выйти из панели"
              className="sidebar-logout"
              onClick={() => setLogoutOpen(true)}
              type="button"
            >
              <LogOut size={14} aria-hidden strokeWidth={1.75} />
              Выйти
            </button>
          </div>
          <span>{apiVersion ? `API ${apiVersion}` : '…'}</span>
          <span className="hint" style={{ fontSize: '0.65rem' }}>
            ⌘K
          </span>
        </div>
      </aside>

      <main className="main-area" id="main-content" tabIndex={-1}>
        <ConnectionBanner />
        <ErrorBoundary key={location.pathname}>
          <Routes>
            <Route element={<Navigate replace to="/status" />} path="/" />
            <Route element={<Navigate replace to="/status" />} path="/home" />
            <Route element={<Navigate replace to="/status" />} path="/dashboard" />
            <Route element={<Navigate replace to="/modules" />} path="/plugins" />
            <Route element={<StatusScreen />} path="/status" />
            <Route element={<ModulesScreen />} path="/modules" />
            <Route element={<MemoryScreen />} path="/memory" />
            <Route element={<SystemScreen />} path="/system" />
            <Route element={<SystemScreen initialTab="backup" />} path="/backups" />
            <Route element={<WebhooksScreen />} path="/webhooks" />
            <Route element={<SettingsScreen />} path="/settings" />
            <Route element={<DocsScreen />} path="/api-docs" />
            {import.meta.env.DEV ? <Route element={<UiKitScreen />} path="/__ui" /> : null}
            <Route element={<NotFoundScreen />} path="*" />
          </Routes>
        </ErrorBoundary>
      </main>

      <CommandPalette />

      <DangerConfirmDialog
        busy={logoutBusy}
        confirmLabel="Выйти"
        confirmPhrase="ВЫЙТИ"
        description="Потребуется снова ввести ключ доступа."
        onCancel={() => setLogoutOpen(false)}
        onConfirm={() => void doLogout()}
        open={logoutOpen}
        title="Выйти из панели?"
      />
    </div>
  )
}
