import type { ReactNode } from 'react'
import { Button } from './button'

type Props = {
  title: string
  subtitle?: string
  actions?: ReactNode
}

/** Shared page chrome — portable to desktop client. */
export function PageHeader({ title, subtitle, actions }: Props) {
  return (
    <div className="page-header page-header-row">
      <div>
        <h1 className="page-title">{title}</h1>
        {subtitle ? <p className="page-sub">{subtitle}</p> : null}
      </div>
      {actions ? <div className="page-header-actions">{actions}</div> : null}
    </div>
  )
}

export function PageHeaderRefresh({
  loading,
  onClick,
  label = 'Обновить',
}: {
  loading?: boolean
  onClick: () => void
  label?: string
}) {
  return (
    <Button disabled={loading} onClick={onClick} type="button" variant="cyan">
      {loading ? 'Обновление…' : label}
    </Button>
  )
}
