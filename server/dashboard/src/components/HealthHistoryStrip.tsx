import { useMemo } from 'react'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { Bar, BarChart, Cell, XAxis, YAxis } from 'recharts'

type Point = {
  timestamp?: string
  ok?: boolean
  backend_ok?: boolean
  storage_ok?: boolean
}

type Props = {
  points: Point[]
  loading?: boolean
}

const config: ChartConfig = {
  ok: { label: 'ok', color: 'var(--emerald)' },
  warn: { label: 'warn', color: 'var(--amber)' },
  down: { label: 'down', color: 'var(--danger)' },
}

export function HealthHistoryStrip({ points, loading }: Props) {
  const data = useMemo(() => {
    return points.map((p, i) => {
      const status = p.ok === false ? 'down' : p.backend_ok === false || p.storage_ok === false ? 'warn' : 'ok'
      return {
        i,
        label: p.timestamp ? String(p.timestamp).slice(11, 16) : String(i),
        value: 1,
        name: status,
        fill: status === 'ok' ? 'var(--emerald)' : status === 'warn' ? 'var(--amber)' : 'var(--danger)',
      }
    })
  }, [points])

  if (loading) {
    return <div aria-busy="true" className="health-strip skeleton-block" />
  }
  if (!data.length) {
    return <p className="page-sub">Нет точек истории health за выбранный период.</p>
  }

  return (
    <ChartContainer className="health-strip-chart !aspect-[10/1] w-full min-h-[72px]" config={config}>
      <BarChart data={data} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
        <XAxis dataKey="label" hide />
        <YAxis hide domain={[0, 1]} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Bar dataKey="value" isAnimationActive={false} radius={1}>
          {data.map((d) => (
            <Cell fill={d.fill} key={d.i} />
          ))}
        </Bar>
      </BarChart>
    </ChartContainer>
  )
}
