'use client';

import React, { useState } from 'react';
import { Brain, ChevronDown } from 'lucide-react';

export interface ReasoningPanelProps {
  content: string;
  durationSeconds?: number;
  initialExpanded?: boolean;
  className?: string;
}

export function ReasoningPanel({
  content,
  durationSeconds,
  initialExpanded = false,
  className = '',
}: ReasoningPanelProps) {
  const [expanded, setExpanded] = useState(initialExpanded);

  if (!content || !content.trim()) {
    return null;
  }

  const durationLabel =
    typeof durationSeconds === 'number'
      ? ` (${durationSeconds.toFixed(1)} с)`
      : '';

  return (
    <div
      className={`my-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-2)] overflow-hidden transition-all duration-150 ${className}`}
    >
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        className="w-full flex items-center justify-between px-3 py-2 text-xs text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-3)] transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
      >
        <div className="flex items-center gap-1.5 font-medium">
          <Brain size={13} className="text-[var(--text-subtle)]" />
          <span>Размышления{durationLabel}</span>
        </div>
        <ChevronDown
          size={13}
          className={`text-[var(--text-subtle)] transition-transform duration-150 ${
            expanded ? 'rotate-180' : ''
          }`}
        />
      </button>

      {expanded && (
        <div className="px-3 py-2.5 text-xs text-[var(--text-muted)] font-mono whitespace-pre-wrap leading-relaxed border-t border-[var(--border)] bg-[var(--surface)] select-text animate-in fade-in duration-100">
          {content}
        </div>
      )}
    </div>
  );
}
