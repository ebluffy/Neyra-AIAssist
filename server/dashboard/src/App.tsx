import { DashboardAuthGate } from './shell/DashboardAuthGate'
import { AppShell } from './shell/AppShell'

export default function App() {
  return (
    <DashboardAuthGate>
      <AppShell />
    </DashboardAuthGate>
  )
}
