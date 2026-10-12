import * as React from 'react'
import * as RechartsPrimitive from 'recharts'
import { cn } from '@/lib/utils'

export type ChartConfig = Record<
  string,
  {
    label?: React.ReactNode
    color?: string
  }
>

const ChartContainer = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<'div'> & {
    config: ChartConfig
    children: React.ComponentProps<typeof RechartsPrimitive.ResponsiveContainer>['children']
  }
>(({ className, children, config, ...props }, ref) => (
  <div
    ref={ref}
    className={cn('flex aspect-video justify-center text-xs [&_.recharts-cartesian-axis-tick_text]:fill-[var(--muted)]', className)}
    data-chart
    style={
      {
        ...Object.fromEntries(
          Object.entries(config).map(([key, item]) => [`--color-${key}`, item.color ?? 'var(--cyan)']),
        ),
      } as React.CSSProperties
    }
    {...props}
  >
    <RechartsPrimitive.ResponsiveContainer width="100%" height="100%">
      {children}
    </RechartsPrimitive.ResponsiveContainer>
  </div>
))
ChartContainer.displayName = 'ChartContainer'

const ChartTooltip = RechartsPrimitive.Tooltip

function ChartTooltipContent({
  active,
  payload,
  label,
}: {
  active?: boolean
  payload?: Array<{ name?: string; value?: number | string; color?: string }>
  label?: string
}) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-xs shadow-[var(--shadow-border)]">
      {label ? <div className="mb-1 font-medium text-[var(--text)]">{label}</div> : null}
      <div className="flex flex-col gap-0.5">
        {payload.map((row) => (
          <div className="flex items-center gap-2 text-[var(--muted)]" key={String(row.name)}>
            <span className="inline-block size-2 rounded-sm" style={{ background: row.color ?? 'var(--cyan)' }} />
            <span>{row.name}</span>
            <span className="ml-auto font-mono tabular-nums text-[var(--text)]">{row.value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export { ChartContainer, ChartTooltip, ChartTooltipContent }
