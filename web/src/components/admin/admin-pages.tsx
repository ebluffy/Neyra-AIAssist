'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Database, FileText, Folder, Key, Loader2, RefreshCw, Search } from 'lucide-react';
import { Button, IconButton } from '../ui';

type PageKind = 'logs' | 'memory' | 'files' | 'prompts';

interface AuditItem {
  id?: string;
  createdAt?: string;
  action?: string;
  actorEmail?: string | null;
  targetType?: string | null;
  targetId?: string | null;
}

interface MemoryPerson {
  id: string;
  idLabel: string;
  displayName: string;
  names: string[];
  accounts: string[];
  discordIds: string[];
}

interface MemoryPayload {
  state: string;
  message: string | null;
  people: MemoryPerson[];
  counts: { matched: number; total: number };
  stats: Record<string, unknown> | null;
}

const TITLES: Record<PageKind, { title: string; hint: string; icon: React.ReactNode }> = {
  logs: {
    title: 'Журналы',
    hint: 'Действия админки и последние операции ядра',
    icon: <FileText size={16} />,
  },
  memory: {
    title: 'Память',
    hint: 'Люди и статистика долгой памяти Neyra',
    icon: <Database size={16} />,
  },
  files: {
    title: 'Файлы',
    hint: 'Вложения, которые Neyra принимает в чате',
    icon: <Folder size={16} />,
  },
  prompts: {
    title: 'Промпты',
    hint: 'Персона и системные инструкции ядра',
    icon: <Key size={16} />,
  },
};

export function AdminPageSection({ kind }: { kind: PageKind }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<{ items: AuditItem[]; coreState: string | null; coreMessage: string | null } | null>(null);
  const [memory, setMemory] = useState<MemoryPayload | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNote(null);
    try {
      if (kind === 'logs') {
        const response = await fetch('/api/admin/logs?limit=50', { cache: 'no-store' });
        const payload = await response.json().catch(() => null);
        if (!response.ok) throw new Error(payload?.message || 'Журнал недоступен.');
        const data = payload?.data ?? payload;
        setLogs({
          items: Array.isArray(data?.items) ? data.items : [],
          coreState: data?.core?.state ?? null,
          coreMessage: data?.core?.message ?? null,
        });
      } else if (kind === 'memory') {
        const url = query.trim()
          ? `/api/admin/memory?q=${encodeURIComponent(query.trim())}`
          : '/api/admin/memory';
        const response = await fetch(url, { cache: 'no-store' });
        const payload = await response.json().catch(() => null);
        if (!response.ok) throw new Error(payload?.message || 'Память недоступна.');
        setMemory(payload?.data ?? payload);
      } else {
        const response = await fetch(`/api/admin/${kind}`, { cache: 'no-store' });
        const payload = await response.json().catch(() => null);
        if (!response.ok) throw new Error(payload?.message || 'Раздел недоступен.');
        const data = payload?.data ?? payload;
        setNote(data?.message || 'Раздел пока недоступен.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка загрузки.');
    } finally {
      setLoading(false);
    }
  }, [kind, query]);

  useEffect(() => {
    void load();
  }, [load]);

  const meta = TITLES[kind];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 text-[var(--text-muted)]">{meta.icon}</span>
          <div>
            <h3 className="text-base font-semibold text-[var(--text)]">{meta.title}</h3>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">{meta.hint}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {kind === 'memory' && (
            <div className="relative">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-subtle)]" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void load();
                }}
                placeholder="Имя, аккаунт, Discord ID"
                className="w-[200px] rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] pl-7 pr-2 py-1.5 text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]"
              />
            </div>
          )}
          <IconButton
            aria-label={`Обновить раздел ${meta.title}`}
            tooltip="Обновить"
            icon={<RefreshCw size={14} className={loading ? 'animate-spin' : ''} />}
            variant="ghost"
            size="sm"
            onClick={() => void load()}
          />
        </div>
      </div>

      {loading && (
        <div className="flex items-center gap-2 py-10 justify-center text-xs text-[var(--text-muted)]">
          <Loader2 size={16} className="animate-spin" />
          Загрузка…
        </div>
      )}

      {error && !loading && (
        <div role="alert" className="flex items-center gap-2 p-3 rounded-[var(--radius-sm)] border border-[var(--danger)]/40 bg-[var(--danger-quiet)] text-xs text-[var(--danger)]">
          <AlertCircle size={14} />
          <span>{error}</span>
          <Button variant="secondary" size="sm" className="ml-auto" onClick={() => void load()}>
            Повторить
          </Button>
        </div>
      )}

      {!loading && !error && kind === 'logs' && logs && (
        <div className="space-y-2">
          {logs.coreState && logs.coreState !== 'ok' && (
            <p className="text-[11px] text-[var(--text-subtle)]">
              Журнал ядра: {logs.coreMessage || logs.coreState}
            </p>
          )}
          {logs.items.length === 0 ? (
            <p className="text-xs text-[var(--text-muted)] py-6 text-center">Записей пока нет.</p>
          ) : (
            <ul className="divide-y divide-[var(--border)] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
              {logs.items.map((item, index) => (
                <li key={item.id || `${item.action}-${index}`} className="px-3 py-2 text-xs flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="font-mono text-[10px] text-[var(--text-subtle)]">
                    {item.createdAt ? new Date(item.createdAt).toLocaleString('ru-RU') : '—'}
                  </span>
                  <span className="font-medium text-[var(--text)]">{item.action || '—'}</span>
                  <span className="text-[var(--text-muted)]">{item.actorEmail || 'система'}</span>
                  {item.targetType && (
                    <span className="text-[10px] text-[var(--text-subtle)]">
                      {item.targetType}:{item.targetId || '—'}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {!loading && !error && kind === 'memory' && memory && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2 text-[11px]">
            <span className="px-2 py-1 rounded border border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]">
              найдено: {memory.counts.matched} из {memory.counts.total}
            </span>
            {memory.stats && (
              <span className="px-2 py-1 rounded border border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]">
                STM: {String(memory.stats.short_memory_size ?? '—')} · LTM: {String(memory.stats.long_memory_records ?? '—')}
              </span>
            )}
          </div>
          {memory.people.length === 0 ? (
            <p className="text-xs text-[var(--text-muted)] py-6 text-center">Совпадений нет.</p>
          ) : (
            <ul className="space-y-1.5">
              {memory.people.map((person) => (
                <li key={person.id || person.idLabel} className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
                  <div className="text-xs font-medium text-[var(--text)]">{person.displayName || 'Без имени'}</div>
                  <div className="text-[11px] text-[var(--text-muted)]">
                    {[...person.accounts, ...person.discordIds].join(' · ') || person.idLabel}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {!loading && !error && (kind === 'files' || kind === 'prompts') && (
        <div className="rounded-[var(--radius)] border border-dashed border-[var(--border)] p-6 text-center space-y-2">
          <p className="text-xs text-[var(--text-muted)]">{note}</p>
          <p className="text-[11px] text-[var(--text-subtle)]">
            Раздел включится, когда ядро отдаст API перечисления; сейчас панель не читает файлы напрямую.
          </p>
        </div>
      )}
    </div>
  );
}
