import { DashboardAuthGate } from './shell/DashboardAuthGate'
import { AppShell } from './shell/AppShell'
import { ErrorBoundary } from './components/ErrorBoundary'

export default function App() {
  return (
    <DashboardAuthGate>
      <ErrorBoundary>
        <AppShell />
      </ErrorBoundary>
    </DashboardAuthGate>
  )
}
