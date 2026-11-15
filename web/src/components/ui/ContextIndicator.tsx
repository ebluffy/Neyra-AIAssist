'use client';

import React, { useState, useRef, useEffect } from 'react';
import { Sparkles, Plus } from 'lucide-react';

export interface ContextLaneUsage {
  used?: number;
  limit?: number;
}

export interface ContextPolicy {
  compaction_enabled?: boolean;
  mode?: 'messages' | 'off' | string;
  threshold_messages?: number;
}

// Формат ядра #73: {total, lanes}. Неизвестные поля отсутствуют, а не равны нулю;
// индикатор показывается только когда ядро реально сообщило used и limit.
export interface ContextUsage {
  total?: ContextLaneUsage;
  lanes?: {
    talk?: ContextLaneUsage;
    brain?: ContextLaneUsage;
    memory?: ContextLaneUsage;
    vision?: ContextLaneUsage;
  };
  policy?: ContextPolicy;
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

  if (!usage || typeof usage.total?.used !== 'number' || typeof usage.total?.limit !== 'number' || usage.total.limit <= 0) {
    return null;
  }

  const used = Math.max(0, usage.total.used);
  const limit = usage.total.limit;
  const percentage = Math.min(100, Math.round((used / limit) * 100));
  // Visual highlight heuristic only (per developer guidance, >= 80% marks as high usage)
  const isHigh = percentage >= 80;

  // Только реальные пары used/limit из ядра: недостающие лейны не дорисовываем.
  const lanes = ([
    { key: 'brain', label: 'Рассуждения (Brain)' },
    { key: 'talk', label: 'Диалог (Talk)' },
    { key: 'vision', label: 'Изображения (Vision)' },
    { key: 'memory', label: 'Память (Memory)' },
  ] as const).flatMap((lane) => {
    const entry = usage.lanes?.[lane.key];
    if (!entry || typeof entry.used !== 'number' || typeof entry.limit !== 'number' || entry.limit <= 0) return [];
    return [{ ...lane, used: Math.max(0, entry.used), limit: entry.limit }];
  });

  // Derive policy / auto-compaction text without hardcoded numbers
  let policyText: string | null = null;
  if (usage.policy) {
    if (usage.policy.compaction_enabled === false || usage.policy.mode === 'off') {
      policyText = 'Автосжатие выключено';
    } else if (usage.policy.threshold_messages && usage.policy.threshold_messages > 0) {
      policyText = `Автосжатие: после ${usage.policy.threshold_messages} сообщений`;
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

          {/* Lanes breakdown: only lanes the kernel actually reported */}
          {lanes.length > 0 && (
            <div className="space-y-2.5 pt-1">
              <div className="text-[11px] font-medium text-[var(--text-subtle)] uppercase tracking-wider">
                Лейны контекста
              </div>
              {lanes.map(lane => {
                const lanePct = Math.min(100, Math.round((lane.used / lane.limit) * 100));
                const laneHigh = lanePct >= 80;

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
                    </div>
                  </div>
                );
              })}
            </div>
          )}

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
