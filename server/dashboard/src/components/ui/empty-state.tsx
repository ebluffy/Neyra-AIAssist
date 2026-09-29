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
      <div className="empty-state-icon">
        <Icon size={24} />
      </div>
      <p style={{ fontWeight: 600, color: 'var(--text)', fontSize: '0.9rem' }}>{title}</p>
      {description && <p style={{ fontSize: '0.8rem', maxWidth: 320 }}>{description}</p>}
      {action}
    </div>
  )
}
