import { useEffect, useState } from 'react'
import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import {
  BookOpenText, Gauge, House, Menu, PlugZap, Settings, Webhook, X, Cpu,
} from 'lucide-react'
import { DashboardPage } from './pages/DashboardPage'
import { DocsPage } from './pages/DocsPage'
import { HomePage } from './pages/HomePage'
import { PluginsPage } from './pages/PluginsPage'
import { SettingsPage } from './pages/SettingsPage'
import { WebhooksPage } from './pages/WebhooksPage'

const NAV = [
  { to: '/home',     label: 'Микро-сайт',  icon: House },
  { to: '/dashboard',label: 'Дашборд',     icon: Gauge },
  { to: '/plugins',  label: 'Плагины',     icon: PlugZap },
  { to: '/settings', label: 'Настройки',   icon: Settings },
  { to: '/webhooks', label: 'Вебхуки',     icon: Webhook },
  { to: '/api-docs', label: 'API Docs',    icon: BookOpenText },
]

export default function App() {
  const [open, setOpen] = useState(false)
  const [mobile, setMobile] = useState(false)

  useEffect(() => {
    const check = () => setMobile(window.innerWidth < 768)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  useEffect(() => { if (!mobile) setOpen(false) }, [mobile])

  return (
    <div className="app-shell">
      {/* Mobile toggle */}
      {mobile && (
        <button
          aria-label="Открыть меню"
          className="mobile-toggle"
          onClick={() => setOpen(true)}
          type="button"
        >
          <Menu size={20} />
        </button>
      )}

      {/* Overlay */}
      {mobile && open && (
        <div
          aria-hidden
          className="mobile-overlay"
          onClick={() => setOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside className={`sidebar${open ? ' open' : ''}`}>
        <div className="sidebar-logo">
          <div className="sidebar-logo-icon">
            <Cpu size={18} color="#fff" />
          </div>
          <div className="sidebar-logo-text">
            <span className="sidebar-logo-name">Neyra</span>
            <span className="sidebar-logo-sub">Control Center</span>
          </div>
          {mobile && (
            <button
              aria-label="Закрыть меню"
              onClick={() => setOpen(false)}
              style={{
                marginLeft: 'auto', background: 'none', border: 'none',
                color: 'var(--muted)', cursor: 'pointer', padding: '0.25rem',
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
              <Icon className="nav-item-icon" size={18} />
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer">
          v0.9 · local instance
        </div>
      </aside>

      {/* Main */}
      <main className="main-area">
        <Routes>
          <Route element={<Navigate replace to="/home" />} path="/" />
          <Route element={<HomePage />}      path="/home" />
          <Route element={<DashboardPage />} path="/dashboard" />
          <Route element={<PluginsPage />}   path="/plugins" />
          <Route element={<SettingsPage />}  path="/settings" />
          <Route element={<WebhooksPage />}  path="/webhooks" />
          <Route element={<DocsPage />}      path="/api-docs" />
          <Route element={<Navigate replace to="/home" />} path="*" />
        </Routes>
      </main>
    </div>
  )
}
