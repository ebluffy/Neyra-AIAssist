import { getAdminUser } from '../../../../lib/admin-page-guard';
import { listUsers, countUsers } from '../../../../lib/admin-users';
import { parseUserListQuery } from '../../../../lib/admin-rules';
import { UserRowActions } from '../../../components/admin/user-row-actions';
import { Pagination } from '../../../components/admin/pagination';
import { Card, EmptyState, PageHeader, Stat, StatusPill, formatDate, tableClass, tdClass, thClass } from '../../../components/admin/ui';

export const dynamic = 'force-dynamic';

const fieldClass = 'rounded-[var(--radius)] border border-[var(--border)] bg-transparent px-2 py-1.5 text-sm';

export default async function AdminUsersPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [params, actor] = await Promise.all([searchParams, getAdminUser()]);
  const query = parseUserListQuery(params);
  let page: Awaited<ReturnType<typeof listUsers>> | null = null;
  let counts: Awaited<ReturnType<typeof countUsers>> | null = null;
  let dbError = false;
  try {
    [page, counts] = await Promise.all([listUsers(query), countUsers()]);
  } catch {
    dbError = true;
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Пользователи"
        description="Роль проверяется на сервере при каждом действии. Снять роль с себя или удалить последнего администратора нельзя."
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Всего" value={counts?.total ?? '—'} />
        <Stat label="Администраторы" value={counts?.admins ?? '—'} />
        <Stat label="Заблокированы" value={counts?.banned ?? '—'} />
      </div>

      <Card>
        <form method="get" className="mb-4 flex flex-wrap items-end gap-2">
          <label className="grid gap-1 text-xs">
            Поиск
            <input name="q" defaultValue={query.q} placeholder="email или имя" className={fieldClass} />
          </label>
          <label className="grid gap-1 text-xs">
            Роль
            <select name="role" defaultValue={query.role} className={fieldClass}>
              <option value="all">все</option>
              <option value="admin">admin</option>
              <option value="user">user</option>
            </select>
          </label>
          <label className="grid gap-1 text-xs">
            Статус
            <select name="status" defaultValue={query.status} className={fieldClass}>
              <option value="all">все</option>
              <option value="active">активные</option>
              <option value="banned">заблокированные</option>
            </select>
          </label>
          <button type="submit" className="rounded-[var(--radius)] border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-white/5">
            Найти
          </button>
        </form>

        {dbError ? (
          <EmptyState title="База сайта недоступна" text="Список не загрузился. Проверьте PostgreSQL и DATABASE_URL, затем обновите страницу." />
        ) : !page || page.items.length === 0 ? (
          <EmptyState
            title={query.q ? 'Никого не нашли' : 'Пользователей пока нет'}
            text={query.q ? 'Измените запрос или сбросьте фильтры.' : 'Первый пользователь появится после регистрации по приглашению.'}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className={tableClass}>
              <thead>
                <tr>
                  <th className={thClass}>Пользователь</th>
                  <th className={thClass}>Роль</th>
                  <th className={thClass}>Статус</th>
                  <th className={thClass}>Регистрация</th>
                  <th className={thClass}>Последний вход</th>
                  <th className={thClass}>Действия</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map(row => (
                  <tr key={row.id}>
                    <td className={tdClass}>
                      <span className="block text-sm">{row.email}</span>
                      {row.name && row.name !== row.email && <span className="block text-xs text-[var(--muted)]">{row.name}</span>}
                      {row.id === actor?.id && <span className="mt-0.5 block text-xs text-[var(--muted)]">это вы</span>}
                    </td>
                    <td className={tdClass}><StatusPill tone={row.role === 'admin' ? 'ok' : 'muted'}>{row.role}</StatusPill></td>
                    <td className={tdClass}>
                      {row.banned
                        ? <StatusPill tone="error">заблокирован{row.banReason ? `: ${row.banReason}` : ''}</StatusPill>
                        : <StatusPill tone="muted">активен</StatusPill>}
                    </td>
                    <td className={`${tdClass} whitespace-nowrap text-xs text-[var(--muted)]`}>{formatDate(row.createdAt)}</td>
                    <td className={`${tdClass} whitespace-nowrap text-xs text-[var(--muted)]`}>{formatDate(row.lastLoginAt)}</td>
                    <td className={tdClass}>
                      <UserRowActions
                        user={{ id: row.id, email: row.email, name: row.name, role: row.role, banned: row.banned, banReason: row.banReason }}
                        isSelf={row.id === actor?.id}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {page && (
          <Pagination
            page={page.page}
            pageSize={page.pageSize}
            total={page.total}
            basePath="/admin/users"
            params={{ q: query.q, role: query.role, status: query.status }}
          />
        )}
      </Card>
    </div>
  );
}
