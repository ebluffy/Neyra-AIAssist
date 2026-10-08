import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

type Props = {
  icon: LucideIcon
  title: string
  description?: string
  action?: ReactNode
}

export function EmptyState({ icon: Icon, title, description, action }: Props) {
  return (
    <div className="empty-state">
      <div aria-hidden className="empty-state-icon">
        <Icon size={22} strokeWidth={1.75} />
      </div>
      <p className="empty-state-title">{title}</p>
      {description ? <p className="empty-state-desc">{description}</p> : null}
      {action}
    </div>
  )
}
