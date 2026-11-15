import { coreGet } from '../../../../lib/core-admin';
import { readAdminConfig } from '../../../../lib/admin-config';
import { ExportPeople } from '../../../components/admin/export-button';
import { MemoryLimitsForm } from '../../../components/admin/memory-limits-form';
import { accountLabels, discordLabels, personAliases, personIdLabel, personTitle } from '../../../../lib/admin-memory';
import { Card, EmptyState, PageHeader, Stat, StatusPill, tableClass, tdClass, thClass } from '../../../components/admin/ui';

export const dynamic = 'force-dynamic';

interface MemoryPerson {
  id?: string;
  display_name?: string;
  names?: string[];
  accounts?: Array<string | { platform?: string; handle?: string | null; platform_user_id?: string | null }>;
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
  const [people, stats, configResult] = await Promise.all([
    coreGet<MemoryPeople>('/v1/memory/people?limit=500', { timeoutMs: 5000 }),
    coreGet<MemoryStats>('/v1/memory/stats', { timeoutMs: 4000 }),
    readAdminConfig(),
  ]);
  const config = configResult.state === 'ok' ? configResult.data : null;
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

      <Card
        title="Лимиты и автосжатие"
        description={config ? 'Сохранение идёт в конфиг ядра. Лимиты памяти применяются после перезапуска.' : configResult.message ?? 'Ядро не отдало конфиг.'}
      >
        {config ? (
          <MemoryLimitsForm limits={config.memory.limits} autocompact={config.memory.autocompact} />
        ) : (
          <EmptyState title="Настройки недоступны" text="Проверьте подключение ядра и ключ сайта." />
        )}
      </Card>

      <Card>
        <form method="get" className="mb-4 flex flex-wrap items-end gap-2">
          <label className="grid gap-1 text-xs">
            Поиск по людям
            <input name="q" defaultValue={q} placeholder="имя, аккаунт, discord id" className={fieldClass} />
          </label>
          <button type="submit" className="rounded-[var(--radius)] border border-[var(--border)] px-3 py-1.5 text-sm bg-[var(--surface-2)] text-[var(--text)] hover:bg-[var(--surface-3)] font-medium">
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
                {filtered.slice(0, 200).map(person => {
                  const idLabel = personIdLabel(person);
                  return (
                    <tr key={person.id ?? personTitle(person)}>
                      <td className={tdClass}>
                        <span className="block text-sm">{personTitle(person)}</span>
                        {idLabel && <span className="block font-mono text-xs text-[var(--muted)]">{idLabel}</span>}
                      </td>
                      <td className={`${tdClass} text-xs`}>{personAliases(person).join(', ') || '—'}</td>
                      <td className={`${tdClass} text-xs`}>{accountLabels(person.accounts).join(', ') || '—'}</td>
                      <td className={`${tdClass} text-xs`}>{discordLabels(person).join(', ') || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--muted)]">
          <span className="flex items-center gap-2">
            <StatusPill tone="muted">только чтение</StatusPill>
            Найдено: {filtered.length} из {rows.length} загруженных (ядро отдаёт до 500).
          </span>
          <ExportPeople people={filtered.slice(0, 200).map(person => ({
            id: person.id ?? '',
            displayName: personTitle(person),
            names: personAliases(person),
            accounts: accountLabels(person.accounts),
            discordIds: discordLabels(person),
          }))} />
        </div>
      </Card>
    </div>
  );
}
