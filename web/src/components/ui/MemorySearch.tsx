'use client';

import React from 'react';
import { Search, X } from 'lucide-react';

export type MemoryScope = 'all' | 'facts' | 'diary' | 'ltm';

export interface MemorySearchProps {
  query: string;
  onQueryChange: (query: string) => void;
  scope: MemoryScope;
  onScopeChange: (scope: MemoryScope) => void;
  className?: string;
}

export function MemorySearch({
  query,
  onQueryChange,
  scope,
  onScopeChange,
  className = '',
}: MemorySearchProps) {
  const scopes: { id: MemoryScope; label: string }[] = [
    { id: 'all', label: 'Все' },
    { id: 'facts', label: 'Факты' },
    { id: 'diary', label: 'Дневник' },
    { id: 'ltm', label: 'LTM' },
  ];

  return (
    <div className={`space-y-2.5 ${className}`}>
      <div className="relative">
        <Search
          size={14}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-subtle)] pointer-events-none"
        />
        <input
          type="text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Поиск по сохранённой памяти..."
          className="w-full h-9 pl-9 pr-8 text-xs bg-[var(--surface-2)] text-[var(--text)] rounded-[var(--radius)] border border-[var(--border-control)] placeholder:text-[var(--text-subtle)] focus:outline-none focus-visible:border-[var(--accent)] focus-visible:ring-1 focus-visible:ring-[var(--accent)] transition-colors"
        />
        {query && (
          <button
            type="button"
            onClick={() => onQueryChange('')}
            aria-label="Очистить поиск"
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-subtle)] hover:text-[var(--text)] transition-colors"
          >
            <X size={13} />
          </button>
        )}
      </div>

      <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
        {scopes.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => onScopeChange(s.id)}
            className={`px-2.5 py-1 text-xs font-medium rounded-[var(--radius-sm)] transition-colors select-none ${
              scope === s.id
                ? 'bg-[var(--accent)] text-[var(--accent-ink)]'
                : 'bg-[var(--surface-2)] text-[var(--text-muted)] hover:bg-[var(--surface-3)] border border-[var(--border)]'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}
