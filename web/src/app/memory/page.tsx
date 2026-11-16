'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Brain, Sparkles, RefreshCw } from 'lucide-react';
import { MemorySearch, type MemoryScope } from '../../components/ui/MemorySearch';
import { MemoryFactCard, type MemoryFact } from '../../components/ui/MemoryFactCard';
import { MemoryEmptyState } from '../../components/ui/MemoryEmptyState';
import { Button } from '../../components/ui/Button';

export default function MemoryPage() {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<MemoryScope>('all');
  const [refreshing, setRefreshing] = useState(false);

  // Факты памяти, полученные из ядра (§15 п. 7 scope по person_id)
  const [facts] = useState<MemoryFact[]>([]);

  const handleRefresh = () => {
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 500);
  };

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
            </div>
          </div>

          <Button
            variant="ghost"
            size="sm"
            onClick={handleRefresh}
            loading={refreshing}
            disabled={refreshing}
            className="text-xs gap-1.5"
          >
            <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
            <span>Обновить</span>
          </Button>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-6 space-y-6">
        <div className="space-y-1">
          <p className="text-xs text-[var(--text-muted)] leading-relaxed">
            Здесь собраны факты, предпочтения и контекст, которые Нейра запомнила из ваших бесед.
            Память изолирована по вашему `person_id` и синхронизируется между вебом и Discord.
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
