'use client';

import React from 'react';
import { Brain, ShieldCheck } from 'lucide-react';

export interface MemoryEmptyStateProps {
  isSearchActive?: boolean;
  className?: string;
}

export function MemoryEmptyState({
  isSearchActive = false,
  className = '',
}: MemoryEmptyStateProps) {
  return (
    <div
      className={`p-8 rounded-[var(--radius)] bg-[var(--surface-2)] border border-[var(--border)] text-center space-y-3 ${className}`}
    >
      <div className="w-10 h-10 rounded-full bg-[var(--surface-3)] text-[var(--accent)] flex items-center justify-center mx-auto">
        <Brain size={20} />
      </div>
      <div className="space-y-1">
        <h3 className="text-sm font-semibold text-[var(--text)]">
          {isSearchActive ? 'Факты не найдены' : 'Память ещё формируется'}
        </h3>
        <p className="text-xs text-[var(--text-muted)] max-w-sm mx-auto leading-relaxed">
          {isSearchActive
            ? 'Попробуйте изменить поисковый запрос или переключить область поиска.'
            : 'Нейра запоминает ключевые факты и контекст ваших диалогов в фоновом режиме ядра.'}
        </p>
      </div>
      <div className="pt-2 flex items-center justify-center gap-1.5 text-[11px] text-[var(--text-subtle)]">
        <ShieldCheck size={12} />
        <span>Память изолирована по person_id (§15 п. 7)</span>
      </div>
    </div>
  );
}
