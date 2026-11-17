'use client';

import React from 'react';
import { Tag, Calendar, Trash2, Copy, Check } from 'lucide-react';
import { Button } from './Button';
import { Tooltip } from './Tooltip';

export interface MemoryFact {
  id: string;
  fact: string;
  category?: string;
  createdAt: string;
  confidence?: number;
  source?: string;
}

export interface MemoryFactCardProps {
  fact: MemoryFact;
  onDelete?: (id: string) => void;
  canDelete?: boolean;
  className?: string;
}

export function MemoryFactCard({
  fact,
  onDelete,
  canDelete = false,
  className = '',
}: MemoryFactCardProps) {
  const [copied, setCopied] = React.useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(fact.fact);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  const formattedDate = new Date(fact.createdAt).toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

  return (
    <div
      className={`p-3.5 rounded-[var(--radius)] bg-[var(--surface-2)] border border-[var(--border-control)] space-y-2.5 transition-colors hover:border-[var(--border-strong)] ${className}`}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs text-[var(--text)] leading-relaxed select-text flex-1">
          {fact.fact}
        </p>
        <div className="flex items-center gap-1 shrink-0">
          <Tooltip content={copied ? 'Скопировано!' : 'Копировать факт'}>
            <button
              type="button"
              onClick={handleCopy}
              aria-label="Копировать факт"
              className="p-1 rounded-[var(--radius-sm)] text-[var(--text-subtle)] hover:text-[var(--text)] hover:bg-[var(--surface-3)] transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
            >
              {copied ? <Check size={13} className="text-[var(--accent)]" /> : <Copy size={13} />}
            </button>
          </Tooltip>
          {canDelete && onDelete && (
            <Tooltip content="Удалить из памяти">
              <button
                type="button"
                onClick={() => onDelete(fact.id)}
                aria-label="Удалить факт"
                className="p-1 rounded-[var(--radius-sm)] text-[var(--text-subtle)] hover:text-[var(--danger)] hover:bg-[var(--danger-quiet)] transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--danger)]"
              >
                <Trash2 size={13} />
              </button>
            </Tooltip>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-[var(--border)] text-[11px] text-[var(--text-subtle)]">
        {fact.category && (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-[var(--surface-3)] text-[var(--text-muted)] font-medium">
            <Tag size={10} />
            <span>{fact.category}</span>
          </span>
        )}
        <span className="inline-flex items-center gap-1">
          <Calendar size={10} />
          <span>{formattedDate}</span>
        </span>
        {typeof fact.confidence === 'number' && (
          <span className="font-mono text-[10px]">
            Уверенность: {Math.round(fact.confidence * 100)}%
          </span>
        )}
      </div>
    </div>
  );
}
