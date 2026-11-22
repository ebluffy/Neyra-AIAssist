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
  const ms = Math.max(0, value);
  if (ms < 999.5) return `${Math.round(ms)} мс`;
  const seconds = Math.round(ms / 100) / 10;
  if (seconds < 60) return `${seconds.toFixed(1).replace('.', ',')} с`;
  const whole = Math.round(ms / 1000);
  return `${Math.floor(whole / 60)} мин ${whole % 60} с`;
}

export function pluralCalls(value: number): string {
  const mod10 = value % 10;
  const mod100 = value % 100;
  if (mod10 === 1 && mod100 !== 11) return 'вызов';
  if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) return 'вызова';
  return 'вызовов';
}

export function callsLabel(value: number): string {
  return `${value} ${pluralCalls(value)}`;
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
  if (!stats || typeof stats.duration_ms !== 'number' || !stats.lanes || typeof stats.lanes !== 'object') return null;
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
                  {item.calls > 1 ? ` · ${callsLabel(item.calls)}` : ''}
                </span>
              </div>
            );
          })}
        </div>
      </details>
    </div>
  );
}
