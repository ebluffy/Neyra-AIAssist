import { WifiOff } from 'lucide-react'

/** Stub: show when core is unreachable (wired later to health poll). */
export function ConnectionBanner({ visible = false }: { visible?: boolean }) {
  if (!visible) return null
  return (
    <div className="connection-banner" role="status">
      <WifiOff aria-hidden size={14} strokeWidth={1.75} />
      Нет связи с ядром
    </div>
  )
}
