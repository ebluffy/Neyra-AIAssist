'use client';

import React from 'react';
import { GitBranch, ChevronLeft, ChevronRight } from 'lucide-react';
import { Tooltip } from './Tooltip';

export interface BranchTreeProps {
  currentBranchIndex: number;
  totalBranches: number;
  onSelectBranch?: (index: number) => void;
  className?: string;
}

export function BranchTree({
  currentBranchIndex = 0,
  totalBranches = 1,
  onSelectBranch,
  className = '',
}: BranchTreeProps) {
  if (totalBranches <= 1) {
    return null;
  }

  const handlePrev = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (currentBranchIndex > 0) {
      onSelectBranch?.(currentBranchIndex - 1);
    }
  };

  const handleNext = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (currentBranchIndex < totalBranches - 1) {
      onSelectBranch?.(currentBranchIndex + 1);
    }
  };

  return (
    <div
      role="group"
      aria-label="Навигация по веткам сообщения"
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-[var(--surface-2)] border border-[var(--border-control)] text-xs text-[var(--text-muted)] select-none ${className}`}
    >
      <GitBranch size={11} className="text-[var(--text-subtle)]" />
      <Tooltip content="Предыдущий вариант">
        <button
          type="button"
          onClick={handlePrev}
          disabled={currentBranchIndex <= 0}
          aria-label="Предыдущая ветка"
          className="p-0.5 rounded hover:bg-[var(--surface-3)] text-[var(--text)] disabled:opacity-40 disabled:hover:bg-transparent transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
        >
          <ChevronLeft size={12} />
        </button>
      </Tooltip>
      <span className="font-mono text-[11px] px-1 text-[var(--text)]">
        {currentBranchIndex + 1} / {totalBranches}
      </span>
      <Tooltip content="Следующий вариант">
        <button
          type="button"
          onClick={handleNext}
          disabled={currentBranchIndex >= totalBranches - 1}
          aria-label="Следующая ветка"
          className="p-0.5 rounded hover:bg-[var(--surface-3)] text-[var(--text)] disabled:opacity-40 disabled:hover:bg-transparent transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
        >
          <ChevronRight size={12} />
        </button>
      </Tooltip>
    </div>
  );
}
