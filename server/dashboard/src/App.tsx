import { useEffect, useState } from 'react'
import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import {
  BookOpenText, Gauge, LogOut, Menu, PlugZap, Settings, Webhook, X, Cpu,
} from 'lucide-react'
import { clearDashboardGateKey, DashboardAuthGate } from './components/DashboardAuthGate'
import { DashboardPage } from './pages/DashboardPage'
import { DocsPage } from './pages/DocsPage'
import { PluginsPage } from './pages/PluginsPage'
import { SettingsPage } from './pages/SettingsPage'
import { WebhooksPage } from './pages/WebhooksPage'

const NAV = [
  { to: '/dashboard', label: 'Дашборд',   icon: Gauge },
  { to: '/plugins',   label: 'Плагины',   icon: PlugZap },
  { to: '/settings',  label: 'Настройки', icon: Settings },
  { to: '/webhooks',  label: 'Вебхуки',   icon: Webhook },
  { to: '/api-docs',  label: 'API Docs',  icon: BookOpenText },
]

function Shell() {
  const [open, setOpen] = useState(false)
  const [mobile, setMobile] = useState(false)

  useEffect(() => {
    const check = () => setMobile(window.innerWidth < 768)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  useEffect(() => { if (!mobile) setOpen(false) }, [mobile])

  function logout() {
    clearDashboardGateKey()
    window.location.reload()
  }

  return (
    <div className="app-shell">
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

      {mobile && open && (
        <div
          aria-hidden
          className="mobile-overlay"
          onClick={() => setOpen(false)}
        />
      )}

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
          <button className="sidebar-logout" onClick={logout} type="button">
            <LogOut size={14} />
            Выйти
          </button>
          <span>v0.9 · local</span>
        </div>
      </aside>

      <main className="main-area">
        <Routes>
          <Route element={<Navigate replace to="/dashboard" />} path="/" />
          <Route element={<Navigate replace to="/dashboard" />} path="/home" />
          <Route element={<DashboardPage />} path="/dashboard" />
          <Route element={<PluginsPage />}   path="/plugins" />
          <Route element={<SettingsPage />}  path="/settings" />
          <Route element={<WebhooksPage />}  path="/webhooks" />
          <Route element={<DocsPage />}      path="/api-docs" />
          <Route element={<Navigate replace to="/dashboard" />} path="*" />
        </Routes>
      </main>
    </div>
  )
}

export default function App() {
  return (
    <DashboardAuthGate>
      <Shell />
    </DashboardAuthGate>
  )
}
