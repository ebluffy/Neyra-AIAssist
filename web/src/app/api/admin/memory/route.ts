import { requireAdmin } from '../../../../../lib/admin-guard';
import { coreGet } from '../../../../../lib/core-admin';
import { jsonOk } from '../../../../../lib/admin-http';

export const runtime = 'nodejs';
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
  hub?: Record<string, unknown>;
}

// Память: люди и статистика из ядра. Поиск — по именам и аккаунтам, которые ядро уже вернуло.
// Удаление не делаем: у ядра нет API удаления записей памяти, а обход его прав недопустим.
export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const q = (new URL(request.url).searchParams.get('q') ?? '').trim().slice(0, 120).toLowerCase();
  const [people, stats] = await Promise.all([
    coreGet<MemoryPeople>('/v1/memory/people?limit=500', { timeoutMs: 5000 }),
    coreGet<MemoryStats>('/v1/memory/stats', { timeoutMs: 4000 }),
  ]);
  const rows = people.state === 'ok' ? (people.data?.people ?? []) : [];
  const filtered = q
    ? rows.filter(person => {
      const haystack = [
        person.display_name ?? '',
        ...(person.names ?? []),
        ...(person.accounts ?? []),
        ...(person.discord_ids ?? []),
      ].join(' ').toLowerCase();
      return haystack.includes(q);
    })
    : rows;
  return jsonOk({
    state: people.state === 'ok' ? stats.state : people.state,
    message: people.message ?? stats.message ?? null,
    people: filtered.slice(0, 200).map(person => ({
      id: person.id ?? '',
      displayName: person.display_name ?? '',
      names: person.names ?? [],
      accounts: person.accounts ?? [],
      discordIds: person.discord_ids ?? [],
    })),
    counts: {
      matched: filtered.length,
      total: people.data?.count ?? rows.length,
    },
    stats: stats.state === 'ok' ? stats.data : null,
    deletionAvailable: false,
  });
}
