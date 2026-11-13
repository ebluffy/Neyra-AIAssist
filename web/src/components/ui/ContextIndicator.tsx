'use client';

import React, { useState, useRef, useEffect } from 'react';
import { Sparkles, Plus, Minimize2 } from 'lucide-react';

export interface ContextUsage {
  prompt_tokens: number;
  completion_tokens: number;
  context_limit: number;
  context_used: number;
}

export interface ContextIndicatorProps {
  usage?: ContextUsage | null;
  onCompact?: () => void;
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

export function ContextIndicator({ usage, onCompact, onNewChat, className = '' }: ContextIndicatorProps) {
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
  const isHigh = percentage >= 80;

  return (
    <div ref={containerRef} className={`relative inline-block ${className}`}>
      {/* Pill button */}
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Контекст диалога: ${percentage}% использовано`}
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-2 px-2.5 py-1 rounded-[var(--radius-full)] bg-[var(--surface-2)] hover:bg-[var(--surface-3)] border border-[var(--border)] text-xs text-[var(--text-muted)] hover:text-[var(--text)] transition-colors select-none cursor-pointer"
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

      {/* Popover */}
      {open && (
        <div
          role="dialog"
          aria-label="Сведения о контексте"
          className="absolute right-0 bottom-full mb-2 w-72 rounded-[var(--radius-lg)] bg-[var(--surface-2)] border border-[var(--border-strong)] p-3.5 shadow-panel z-40 text-left space-y-3"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-[var(--text)]">Заполненность контекста</span>
            <span className={`text-xs font-semibold ${isHigh ? 'text-[var(--danger)]' : 'text-[var(--accent)]'}`}>
              {percentage}%
            </span>
          </div>

          <div className="space-y-1">
            <div className="w-full h-2 bg-[var(--surface-3)] rounded-full overflow-hidden flex" aria-hidden="true">
              <div
                className={`h-full rounded-full transition-all ${
                  isHigh ? 'bg-[var(--danger)]' : 'bg-[var(--accent)]'
                }`}
                style={{ width: `${percentage}%` }}
              />
            </div>
            <div className="flex justify-between text-[11px] text-[var(--text-subtle)]">
              <span>{formatTokenCount(used)}</span>
              <span>из {formatTokenCount(limit)} токенов</span>
            </div>
          </div>

          <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
            Контекст сжимается автоматически при 80%
          </p>

          <div className="border-t border-[var(--border)] pt-2 space-y-1">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onCompact?.();
              }}
              className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-[var(--radius-sm)] text-xs text-[var(--text)] hover:bg-[var(--surface-3)] transition-colors text-left cursor-pointer"
            >
              <Minimize2 size={13} className="text-[var(--accent)]" />
              <span>Сжать сейчас</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onNewChat?.();
              }}
              className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-[var(--radius-sm)] text-xs text-[var(--text)] hover:bg-[var(--surface-3)] transition-colors text-left cursor-pointer"
            >
              <Plus size={13} className="text-[var(--text-muted)]" />
              <span>Новый чат</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
