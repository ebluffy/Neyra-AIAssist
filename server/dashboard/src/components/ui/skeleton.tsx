import type { CSSProperties } from 'react'
import { cn } from '../../lib/utils'

export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  return <div className={cn('skeleton', className)} style={{ minHeight: 20, ...style }} />
}
