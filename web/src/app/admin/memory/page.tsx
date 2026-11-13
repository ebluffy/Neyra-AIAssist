import { coreGet } from '../../../../lib/core-admin';
import { Card, EmptyState, PageHeader, Stat, StatusPill, tableClass, tdClass, thClass } from '../../../components/admin/ui';

export const dynamic = 'force-dynamic';

interface MemoryPerson {
  id?: string;
  display_name?: string;
  names?: string[];
  accounts?: string[];
  discord_ids?: string[];
}

interface MemoryPeople {
  people?: MemoryPerson[];
  count?: number;
  slug_duplicates?: unknown;
}

interface MemoryStats {
  short_memory_size?: number;
  long_memory_records?: number;
  people_records?: number;
}

const fieldClass = 'rounded-[var(--radius)] border border-[var(--border)] bg-transparent px-2 py-1.5 text-sm';

export default async function AdminMemoryPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const q = (typeof params.q === 'string' ? params.q : '').trim().slice(0, 120);
  const [people, stats] = await Promise.all([
    coreGet<MemoryPeople>('/v1/memory/people?limit=500', { timeoutMs: 5000 }),
    coreGet<MemoryStats>('/v1/memory/stats', { timeoutMs: 4000 }),
  ]);
  const rows = people.state === 'ok' ? people.data?.people ?? [] : [];
  const needle = q.toLowerCase();
  const filtered = needle
    ? rows.filter(person => [
      person.display_name ?? '',
      ...(person.names ?? []),
      ...(person.accounts ?? []),
      ...(person.discord_ids ?? []),
    ].join(' ').toLowerCase().includes(needle))
    : rows;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Память"
        description="Люди и статистика из ядра. Панель только читает: у ядра нет API удаления записей памяти."
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Люди" value={stats.state === 'ok' ? stats.data?.people_records ?? rows.length : '—'} hint="из /v1/memory/stats" />
        <Stat label="Долгая память" value={stats.state === 'ok' ? stats.data?.long_memory_records ?? '—' : '—'} hint="записей" />
        <Stat label="Короткая память" value={stats.state === 'ok' ? stats.data?.short_memory_size ?? '—' : '—'} hint="сообщений в контексте" />
      </div>

      <Card>
        <form method="get" className="mb-4 flex flex-wrap items-end gap-2">
          <label className="grid gap-1 text-xs">
            Поиск по людям
            <input name="q" defaultValue={q} placeholder="имя, аккаунт, discord id" className={fieldClass} />
          </label>
          <button type="submit" className="rounded-[var(--radius)] border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-white/5">
            Найти
          </button>
        </form>

        {people.state !== 'ok' ? (
          <EmptyState
            title="Память недоступна"
            text={people.message ?? 'Ядро не отдало список людей. Проверьте подключение ядра и права ключа сайта.'}
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            title={q ? 'Никого не нашли' : 'Людей в памяти нет'}
            text={q ? 'Попробуйте другой запрос.' : 'Записи появятся, когда Нейра познакомится с людьми в разговорах.'}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className={tableClass}>
              <thead>
                <tr>
                  <th className={thClass}>Имя</th>
                  <th className={thClass}>Имена</th>
                  <th className={thClass}>Аккаунты</th>
                  <th className={thClass}>Discord</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, 200).map(person => (
                  <tr key={person.id ?? person.display_name}>
                    <td className={tdClass}>
                      <span className="block text-sm">{person.display_name || '—'}</span>
                      <span className="font-mono text-xs text-[var(--muted)]">{person.id ?? ''}</span>
                    </td>
                    <td className={`${tdClass} text-xs`}>{(person.names ?? []).join(', ') || '—'}</td>
                    <td className={`${tdClass} text-xs`}>{(person.accounts ?? []).join(', ') || '—'}</td>
                    <td className={`${tdClass} text-xs`}>{(person.discord_ids ?? []).join(', ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 flex items-center gap-2 text-xs text-[var(--muted)]">
          <StatusPill tone="muted">только чтение</StatusPill>
          Найдено: {filtered.length} из {rows.length} загруженных (ядро отдаёт до 500).
        </p>
      </Card>
    </div>
  );
}
