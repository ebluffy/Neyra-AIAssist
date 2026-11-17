'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Brain } from 'lucide-react';
import { MemorySearch, type MemoryScope } from '../../components/ui/MemorySearch';
import { MemoryFactCard, type MemoryFact } from '../../components/ui/MemoryFactCard';
import { MemoryEmptyState } from '../../components/ui/MemoryEmptyState';
import { Badge } from '../../components/ui/Badge';

export interface MemoryViewProps {
  user: {
    id: string;
    name?: string | null;
    email?: string | null;
  };
}

export function MemoryView({ user }: MemoryViewProps) {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<MemoryScope>('all');

  // В этапе P2 память будет запрашиваться из ядра с изоляцией по person_id (§15 п. 7)
  const [facts] = useState<MemoryFact[]>([]);

  const filteredFacts = facts.filter((f) => {
    if (query && !f.fact.toLowerCase().includes(query.toLowerCase())) {
      return false;
    }
    if (scope === 'facts' && f.category !== 'факт') return false;
    if (scope === 'diary' && f.category !== 'дневник') return false;
    if (scope === 'ltm' && f.category !== 'ltm') return false;
    return true;
  });

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <header className="border-b border-[var(--border)] bg-[var(--surface)] sticky top-0 z-30">
        <div className="max-w-4xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link
              href="/chat"
              className="p-1.5 rounded-[var(--radius-sm)] text-[var(--text-subtle)] hover:text-[var(--text)] hover:bg-[var(--surface-2)] transition-colors"
              aria-label="Вернуться в чат"
            >
              <ArrowLeft size={16} />
            </Link>
            <div className="flex items-center gap-2">
              <Brain size={18} className="text-[var(--accent)]" />
              <h1 className="text-sm font-semibold tracking-tight">Память Нейры</h1>
              <Badge tone="muted" size="sm">
                Скоро (P2)
              </Badge>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-6 space-y-6">
        <div className="space-y-1">
          <p className="text-xs text-[var(--text-muted)] leading-relaxed">
            Здесь будут собраны факты, предпочтения и контекст, которые Нейра запомнила из ваших бесед.
            Память будет изолирована по вашему идентификатору личности (<code className="text-[11px] font-mono">{user.id}</code>).
            Интеграция с долгосрочной памятью ядра neyra-core ожидается на этапе P2.
          </p>
        </div>

        <MemorySearch
          query={query}
          onQueryChange={setQuery}
          scope={scope}
          onScopeChange={setScope}
        />

        {filteredFacts.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {filteredFacts.map((fact) => (
              <MemoryFactCard key={fact.id} fact={fact} />
            ))}
          </div>
        ) : (
          <MemoryEmptyState isSearchActive={Boolean(query)} />
        )}
      </main>
    </div>
  );
}
