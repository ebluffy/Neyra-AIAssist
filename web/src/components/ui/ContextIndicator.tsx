'use client';

import React, { useState, useRef, useEffect } from 'react';
import { Sparkles, Plus } from 'lucide-react';

export interface ContextLaneUsage {
  used: number;
  limit: number;
  threshold_pct?: number;
}

export interface ContextPolicy {
  compaction_enabled?: boolean;
  mode?: 'messages' | 'off' | string;
  threshold_messages?: number;
}

export interface ContextUsage {
  prompt_tokens: number;
  completion_tokens: number;
  context_limit: number;
  context_used: number;
  policy?: ContextPolicy;
  lanes?: {
    brain?: ContextLaneUsage;
    talk?: ContextLaneUsage;
    vision?: ContextLaneUsage;
    memory?: ContextLaneUsage;
  };
}

export interface ContextIndicatorProps {
  usage?: ContextUsage | null;
  onNewChat?: () => void;
  className?: string;
}

export function formatTokenCount(num: number): string {
  if (num >= 1_000_000) {
    const val = num / 1_000_000;
    return `${val % 1 === 0 ? val : val.toFixed(1).replace('.', ',')} млн`;
  }
  if (num >= 1_000) {
    const val = num / 1_000;
    return `${val % 1 === 0 ? val : val.toFixed(1).replace('.', ',')} тыс.`;
  }
  return num.toLocaleString('ru-RU');
}

export function ContextIndicator({ usage, onNewChat, className = '' }: ContextIndicatorProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  if (!usage || !usage.context_limit || usage.context_limit <= 0) {
    return null;
  }

  const used = Math.max(0, usage.context_used);
  const limit = usage.context_limit;
  const percentage = Math.min(100, Math.round((used / limit) * 100));
  // Visual highlight heuristic only (per developer guidance, >= 80% marks as high usage)
  const isHigh = percentage >= 80;

  // Resolve lane usages (provided by kernel or calculated proportionally)
  const lanes = [
    {
      key: 'brain',
      label: 'Рассуждения (Brain)',
      used: usage.lanes?.brain?.used ?? Math.round(used * 0.45),
      limit: usage.lanes?.brain?.limit ?? Math.round(limit * 0.5),
      threshold: usage.lanes?.brain?.threshold_pct,
    },
    {
      key: 'talk',
      label: 'Диалог (Talk)',
      used: usage.lanes?.talk?.used ?? Math.round(used * 0.35),
      limit: usage.lanes?.talk?.limit ?? Math.round(limit * 0.25),
      threshold: usage.lanes?.talk?.threshold_pct,
    },
    {
      key: 'vision',
      label: 'Изображения (Vision)',
      used: usage.lanes?.vision?.used ?? Math.round(used * 0.1),
      limit: usage.lanes?.vision?.limit ?? Math.round(limit * 0.15),
      threshold: usage.lanes?.vision?.threshold_pct,
    },
    {
      key: 'memory',
      label: 'Память (Memory)',
      used: usage.lanes?.memory?.used ?? Math.round(used * 0.1),
      limit: usage.lanes?.memory?.limit ?? Math.round(limit * 0.1),
      threshold: usage.lanes?.memory?.threshold_pct,
    },
  ];

  // Derive policy / auto-compaction text without hardcoded numbers
  let policyText: string | null = null;
  if (usage.policy) {
    if (usage.policy.compaction_enabled === false || usage.policy.mode === 'off') {
      policyText = 'Автосжатие выключено';
    } else if (usage.policy.threshold_messages && usage.policy.threshold_messages > 0) {
      policyText = `Автосжатие: после ${usage.policy.threshold_messages} сообщений`;
    }
  } else {
    // If no policy, check if any lane has an explicit threshold_pct from the kernel
    const explicitThreshold = lanes.find(l => typeof l.threshold === 'number')?.threshold;
    if (typeof explicitThreshold === 'number') {
      policyText = `Автосжатие при пороге ${explicitThreshold}%`;
    }
  }

  return (
    <div
      ref={containerRef}
      className={`relative inline-block ${className}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      {/* Pill button */}
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Контекст диалога: ${percentage}% использовано`}
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-2 px-2.5 py-1 rounded-[var(--radius-full)] bg-[var(--surface-2)] hover:bg-[var(--surface-3)] border border-[var(--border)] text-xs text-[var(--text-muted)] hover:text-[var(--text)] transition-colors select-none cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
      >
        <span className="flex items-center gap-1.5">
          <Sparkles size={12} className={isHigh ? 'text-[var(--danger)]' : 'text-[var(--accent)]'} />
          <span className="font-medium text-[var(--text)]">Контекст · {percentage}%</span>
        </span>
        <span className="w-12 h-1.5 bg-[var(--surface-3)] rounded-full overflow-hidden flex" aria-hidden="true">
          <span
            className={`h-full rounded-full transition-all ${
              isHigh ? 'bg-[var(--danger)]' : 'bg-[var(--accent)]'
            }`}
            style={{ width: `${percentage}%` }}
          />
        </span>
      </button>

      {/* Popover on hover/click with lane breakdown */}
      {open && (
        <div
          role="dialog"
          aria-label="Сведения о контексте"
          className="absolute right-0 bottom-full mb-2 w-80 rounded-[var(--radius-lg)] bg-[var(--surface-2)] border border-[var(--border-strong)] p-3.5 shadow-panel z-40 text-left space-y-3.5"
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-[var(--border)] pb-2.5">
            <div>
              <span className="text-xs font-semibold text-[var(--text)]">Контекст диалога</span>
              <div className="text-[11px] text-[var(--text-subtle)] mt-0.5">
                {formatTokenCount(used)} из {formatTokenCount(limit)} токенов
              </div>
            </div>
            <span className={`text-xs font-semibold px-2 py-0.5 rounded ${isHigh ? 'bg-[var(--danger-quiet)] text-[var(--danger)]' : 'bg-[var(--accent-quiet)] text-[var(--accent)]'}`}>
              {percentage}%
            </span>
          </div>

          {/* Overall progress bar */}
          <div className="space-y-1">
            <div className="w-full h-2 bg-[var(--surface-3)] rounded-full overflow-hidden flex" aria-hidden="true">
              <div
                className={`h-full rounded-full transition-all ${
                  isHigh ? 'bg-[var(--danger)]' : 'bg-[var(--accent)]'
                }`}
                style={{ width: `${percentage}%` }}
              />
            </div>
          </div>

          {/* Lanes breakdown: brain / talk / vision / memory */}
          <div className="space-y-2.5 pt-1">
            <div className="text-[11px] font-medium text-[var(--text-subtle)] uppercase tracking-wider">
              Лейны контекста
            </div>
            {lanes.map(lane => {
              const lanePct = lane.limit > 0 ? Math.min(100, Math.round((lane.used / lane.limit) * 100)) : 0;
              const laneHigh = typeof lane.threshold === 'number' ? lanePct >= lane.threshold : lanePct >= 80;

              return (
                <div key={lane.key} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-[var(--text)] font-medium">{lane.label}</span>
                    <span className="text-[11px] text-[var(--text-muted)]">
                      {formatTokenCount(lane.used)} / {formatTokenCount(lane.limit)} ({lanePct}%)
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-1.5 bg-[var(--surface-3)] rounded-full overflow-hidden flex" aria-hidden="true">
                      <div
                        className={`h-full rounded-full transition-all ${
                          laneHigh ? 'bg-[var(--danger)]' : 'bg-[var(--accent)]'
                        }`}
                        style={{ width: `${lanePct}%` }}
                      />
                    </div>
                    {typeof lane.threshold === 'number' && (
                      <span className="text-[10px] text-[var(--text-subtle)] shrink-0">
                        порог {lane.threshold}%
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {(policyText || onNewChat) && (
            <div className={`border-t border-[var(--border)] pt-2.5 flex items-center text-[11px] text-[var(--text-muted)] ${
              policyText && onNewChat ? 'justify-between' : policyText ? 'justify-start' : 'justify-end'
            }`}>
              {policyText && <span>{policyText}</span>}
              {onNewChat && (
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onNewChat();
                  }}
                  className="inline-flex items-center gap-1 text-[var(--accent)] hover:underline cursor-pointer"
                >
                  <Plus size={12} />
                  <span>Новый чат</span>
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
