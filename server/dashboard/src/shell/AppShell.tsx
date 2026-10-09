import { useCallback, useEffect, useMemo, useState } from 'react'
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import {
  ChevronsLeft,
  ChevronsRight,
  Cpu,
  LogOut,
  Menu,
  X,
} from 'lucide-react'
import { apiGet, clearSessionToken, getSessionToken } from '../api'
import type { ApiEnvelope } from '../api'
import { tryAllowNavigation } from '../lib/navigation-guard'
import { applyTheme, getStoredTheme, type Theme } from '../lib/theme'
import { getSidebarCollapsed, setSidebarCollapsed } from '../lib/ui-prefs'
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
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '../components/ui/sheet'
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { NAV_GROUPS, titleForPath } from './nav'
import { Topbar } from './Topbar'

/** Web-only shell (gate + browser session). Screens below are portable to desktop. */
export function AppShell() {
  const [mobileOpen, setMobileOpen] = useState(false)
  const [mobile, setMobile] = useState(false)
  const [collapsed, setCollapsed] = useState(() => getSidebarCollapsed())
  const [apiVersion, setApiVersion] = useState<string>('')
  const [theme, setTheme] = useState<Theme>(() => getStoredTheme())
  const [logoutOpen, setLogoutOpen] = useState(false)
  const [logoutBusy, setLogoutBusy] = useState(false)
  const [cmdOpen, setCmdOpen] = useState(false)
  const [refreshPaused, setRefreshPaused] = useState(false)
  const [lastOkAt, setLastOkAt] = useState<number | null>(null)
  const [nowTick, setNowTick] = useState(() => Date.now())
  const location = useLocation()
  const navigate = useNavigate()

  const { title, crumbs } = useMemo(() => titleForPath(location.pathname), [location.pathname])

  useEffect(() => {
    const check = () => setMobile(window.innerWidth < 768)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  useEffect(() => {
    if (!mobile) setMobileOpen(false)
  }, [mobile])

  useEffect(() => {
    setMobileOpen(false)
  }, [location.pathname])

  useEffect(() => {
    document.title = `${title} · Neyra`
  }, [title])

  useEffect(() => {
    const id = window.setInterval(() => setNowTick(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    void (async () => {
      try {
        const r = await apiGet<ApiEnvelope<{ api_version?: string; version?: string }>>('/v1/meta')
        setApiVersion(String(r.data.api_version ?? r.data.version ?? ''))
        setLastOkAt(Date.now())
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
    clearSessionToken()
    window.location.assign('/')
  }, [])

  function onThemeToggle() {
    const flipped: Theme = theme === 'light' ? 'dark' : 'light'
    applyTheme(flipped)
    setTheme(flipped)
  }

  function toggleCollapsed() {
    const next = !collapsed
    setCollapsed(next)
    setSidebarCollapsed(next)
  }

  async function go(to: string) {
    if (!(await tryAllowNavigation())) return
    setMobileOpen(false)
    navigate(to)
  }

  const agoSec = lastOkAt == null ? null : Math.max(0, Math.floor((nowTick - lastOkAt) / 1000))

  function renderNav(compact: boolean) {
    return (
      <nav className="sidebar-nav" aria-label="Разделы панели">
        {NAV_GROUPS.map((group) => (
          <div className="nav-group" key={group.id}>
            {!compact ? <div className="nav-group-label">{group.label}</div> : null}
            {group.items.map(({ to, label, icon: Icon }) => {
              const link = (
                <NavLink
                  key={to}
                  className={({ isActive }) => `nav-item${isActive ? ' active' : ''}${compact ? ' nav-item-icon-only' : ''}`}
                  onClick={(e) => {
                    e.preventDefault()
                    void go(to)
                  }}
                  to={to}
                  title={compact ? label : undefined}
                >
                  <Icon aria-hidden className="nav-item-icon" size={18} strokeWidth={1.75} />
                  {!compact ? <span>{label}</span> : <span className="sr-only">{label}</span>}
                </NavLink>
              )
              if (!compact) return link
              return (
                <Tooltip key={to}>
                  <TooltipTrigger asChild>{link}</TooltipTrigger>
                  <TooltipContent side="right">{label}</TooltipContent>
                </Tooltip>
              )
            })}
          </div>
        ))}
      </nav>
    )
  }

  const sidebarInner = (opts: { compact: boolean; showClose?: boolean }) => (
    <>
      <div className="sidebar-logo">
        <div className="sidebar-logo-icon" aria-hidden>
          <Cpu size={18} strokeWidth={1.75} />
        </div>
        {!opts.compact ? (
          <div className="sidebar-logo-text">
            <span className="sidebar-logo-name">Neyra</span>
            <span className="sidebar-logo-sub">Панель управления</span>
          </div>
        ) : null}
        {opts.showClose ? (
          <button aria-label="Закрыть меню" className="sidebar-close" onClick={() => setMobileOpen(false)} type="button">
            <X aria-hidden size={18} strokeWidth={1.75} />
          </button>
        ) : null}
      </div>

      {renderNav(opts.compact)}

      <div className="sidebar-footer">
        {!opts.compact ? (
          <div className="row" style={{ gap: '0.4rem', justifyContent: 'center' }}>
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
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                aria-label="Выйти из панели"
                className="sidebar-logout sidebar-logout-icon"
                onClick={() => setLogoutOpen(true)}
                type="button"
              >
                <LogOut size={16} aria-hidden strokeWidth={1.75} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">Выйти</TooltipContent>
          </Tooltip>
        )}
        {!opts.compact ? (
          <>
            <span className="tabular-nums">{apiVersion ? `API ${apiVersion}` : '…'}</span>
            <span className="hint" style={{ fontSize: '0.65rem' }}>
              ⌘K
            </span>
          </>
        ) : null}
        {!mobile ? (
          <button
            aria-label={collapsed ? 'Развернуть меню' : 'Свернуть меню'}
            className="sidebar-collapse"
            onClick={toggleCollapsed}
            type="button"
          >
            {collapsed ? (
              <ChevronsRight aria-hidden size={16} strokeWidth={1.75} />
            ) : (
              <ChevronsLeft aria-hidden size={16} strokeWidth={1.75} />
            )}
            {!opts.compact ? <span>Свернуть</span> : null}
          </button>
        ) : null}
      </div>
    </>
  )

  return (
    <div className={`app-shell${collapsed && !mobile ? ' app-shell-collapsed' : ''}`}>
      <a className="skip-link" href="#main-content">
        К содержимому
      </a>

      {mobile ? (
        <>
          <button
            aria-expanded={mobileOpen}
            aria-label="Открыть меню"
            className="mobile-toggle"
            onClick={() => setMobileOpen(true)}
            type="button"
          >
            <Menu aria-hidden size={20} strokeWidth={1.75} />
          </button>
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetContent className="sidebar-sheet" side="left">
              <SheetHeader className="sr-only">
                <SheetTitle>Навигация</SheetTitle>
              </SheetHeader>
              <div className="sidebar sidebar-in-sheet">{sidebarInner({ compact: false, showClose: true })}</div>
            </SheetContent>
          </Sheet>
        </>
      ) : (
        <aside
          aria-label="Навигация"
          className={`sidebar${collapsed ? ' sidebar-collapsed' : ''}`}
        >
          {sidebarInner({ compact: collapsed })}
        </aside>
      )}

      <div className="shell-main">
        <Topbar
          crumbs={crumbs}
          lastFetchedAgoSec={agoSec}
          onOpenCommand={() => setCmdOpen(true)}
          onThemeToggle={onThemeToggle}
          onToggleRefreshPause={() => setRefreshPaused((v) => !v)}
          refreshPaused={refreshPaused}
          theme={theme}
        />
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
      </div>

      <CommandPalette controlledOpen={cmdOpen} onOpenChange={setCmdOpen} />

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
