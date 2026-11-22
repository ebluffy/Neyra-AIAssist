import React from 'react';
import { ChevronDown } from 'lucide-react';
import type { TurnStats } from '@neyra/contracts';

const LANES: { key: keyof TurnStats['lanes']; label: string }[] = [
  { key: 'brain', label: 'Мозг' },
  { key: 'talk', label: 'Разговор' },
  { key: 'memory', label: 'Память' },
  { key: 'vision', label: 'Зрение' },
];

export function formatDurationMs(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 1000) return `${Math.round(value)} мс`;
  const seconds = value / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0).replace('.', ',')} с`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} мин ${Math.round(seconds % 60)} с`;
}

export function formatModelName(model?: string): string {
  if (!model) return '';
  const id = model.split('/').pop() || model;
  return id.replace(/[-_]/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

export function formatTokensPerSecond(value?: number): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return '';
  return `${value.toFixed(1).replace('.', ',')} ток/с`;
}

export function TurnStatsFooter({ stats }: { stats: TurnStats }) {
  const lanes = LANES.filter((lane) => stats.lanes[lane.key]);
  if (!lanes.length) return null;
  const total = formatDurationMs(stats.duration_ms);
  const speed = formatTokensPerSecond(stats.tokens_per_second);
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] leading-4 text-[var(--text-subtle)]">
      <span>{total}</span>
      {speed && <span aria-hidden="true">·</span>}
      {speed && <span>{speed}</span>}
      <details className="relative group">
        <summary className="list-none cursor-pointer inline-flex items-center gap-1 rounded px-1 -mx-1 hover:bg-[var(--surface-3)] hover:text-[var(--text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]">
          Использовано
          <ChevronDown size={11} aria-hidden="true" className="transition-transform group-open:rotate-180" />
        </summary>
        <div className="absolute left-0 z-20 mt-1 min-w-[280px] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-2)] p-2 shadow-lg">
          {lanes.map((lane) => {
            const item = stats.lanes[lane.key]!;
            return (
              <div key={lane.key} className="flex items-center justify-between gap-3 py-0.5">
                <span className="flex min-w-0 items-baseline gap-1.5">
                  <span className="shrink-0">{lane.label}</span>
                  {item.model && (
                    <span className="truncate text-[var(--text-subtle)]" title={item.model}>
                      {formatModelName(item.model)}
                    </span>
                  )}
                </span>
                <span className="shrink-0 tabular-nums text-[var(--text-muted)]">
                  {formatDurationMs(item.duration_ms)}
                  {item.calls > 1 ? ` · ${item.calls} вызова` : ''}
                </span>
              </div>
            );
          })}
        </div>
      </details>
    </div>
  );
}
