import { Navigate, type RouteObject } from 'react-router-dom'
import { ErrorBoundary } from './components/ErrorBoundary'
import { DocsScreen } from './screens/DocsScreen'
import { MemoryScreen } from './screens/MemoryScreen'
import { ModulesScreen } from './screens/ModulesScreen'
import { NotFoundScreen } from './screens/NotFoundScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { StatusScreen } from './screens/StatusScreen'
import { SystemScreen } from './screens/SystemScreen'
import { UiKitScreen } from './screens/UiKitScreen'
import { WebhooksScreen } from './screens/WebhooksScreen'
import { AppShell } from './shell/AppShell'
import { DashboardAuthGate } from './shell/DashboardAuthGate'

export const appRoutes: RouteObject[] = [
  {
    path: '/',
    element: (
      <DashboardAuthGate>
        <ErrorBoundary>
          <AppShell />
        </ErrorBoundary>
      </DashboardAuthGate>
    ),
    children: [
      { index: true, element: <Navigate replace to="/status" /> },
      { path: 'home', element: <Navigate replace to="/status" /> },
      { path: 'dashboard', element: <Navigate replace to="/status" /> },
      { path: 'plugins', element: <Navigate replace to="/modules" /> },
      { path: 'status', element: <StatusScreen /> },
      { path: 'modules', element: <ModulesScreen /> },
      { path: 'memory', element: <MemoryScreen /> },
      { path: 'system', element: <SystemScreen /> },
      { path: 'backups', element: <SystemScreen initialTab="backup" /> },
      { path: 'webhooks', element: <WebhooksScreen /> },
      { path: 'settings', element: <SettingsScreen /> },
      { path: 'api-docs', element: <DocsScreen /> },
      ...(import.meta.env.DEV ? [{ path: '__ui', element: <UiKitScreen /> }] : []),
      { path: '*', element: <NotFoundScreen /> },
    ],
  },
]
