import { getAdminUser } from '../../../../lib/admin-page-guard';
import { listUsers, countUsers } from '../../../../lib/admin-users';
import { parseUserListQuery } from '../../../../lib/admin-rules';
import { UserRowActions } from '../../../components/admin/user-row-actions';
import { Pagination } from '../../../components/admin/pagination';
import { Card, EmptyState, PageHeader, Stat, StatusPill, formatDate, tableClass, tdClass, thClass } from '../../../components/admin/ui';

export const dynamic = 'force-dynamic';

const fieldClass = 'rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1.5 text-sm text-[var(--text)] focus-visible:outline-none focus-visible:border-[var(--accent)]';

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
        description="Аккаунты сайта, назначение роли администратора, блокировка и сброс паролей без отправки писем."
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Всего" value={counts?.total ?? '—'} />
        <Stat label="Администраторы" value={counts?.admins ?? '—'} />
        <Stat label="Заблокированы" value={counts?.banned ?? '—'} />
      </div>

      <Card>
        <form method="get" className="mb-4 flex flex-wrap items-end gap-2 border-b border-[var(--border)] pb-4">
          <label className="grid gap-1 text-xs text-[var(--text-muted)]">
            Поиск
            <input
              type="search"
              name="q"
              defaultValue={query.q}
              placeholder="email или имя"
              className={fieldClass}
            />
          </label>
          <label className="grid gap-1 text-xs text-[var(--text-muted)]">
            Роль
            <select name="role" defaultValue={query.role} className={fieldClass}>
              <option value="all">все</option>
              <option value="admin">admin</option>
              <option value="user">user</option>
            </select>
          </label>
          <label className="grid gap-1 text-xs text-[var(--text-muted)]">
            Статус
            <select name="status" defaultValue={query.status} className={fieldClass}>
              <option value="all">все</option>
              <option value="active">активные</option>
              <option value="banned">заблокированные</option>
            </select>
          </label>
          <button type="submit" className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-2)] px-3.5 py-1.5 text-sm font-medium text-[var(--text)] hover:bg-[var(--surface-3)] transition-colors">
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
          <>
            {/* Desktop table view */}
            <div className="hidden sm:block overflow-x-auto">
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
                    <tr key={row.id} className="hover:bg-[var(--surface-2)]">
                      <td className={tdClass}>
                        <span className="block text-sm font-medium text-[var(--text)]">{row.email}</span>
                        {row.name && row.name !== row.email && <span className="block text-xs text-[var(--text-muted)]">{row.name}</span>}
                        {row.id === actor?.id && <span className="mt-0.5 block text-xs text-[var(--text-subtle)] font-mono">это вы</span>}
                      </td>
                      <td className={tdClass}><StatusPill tone={row.role === 'admin' ? 'ok' : 'muted'}>{row.role}</StatusPill></td>
                      <td className={tdClass}>
                        {row.banned
                          ? <StatusPill tone="error">заблокирован{row.banReason ? `: ${row.banReason}` : ''}</StatusPill>
                          : <StatusPill tone="muted">активен</StatusPill>}
                      </td>
                      <td className={`${tdClass} whitespace-nowrap text-xs text-[var(--text-muted)]`}>{formatDate(row.createdAt)}</td>
                      <td className={`${tdClass} whitespace-nowrap text-xs text-[var(--text-muted)]`}>{formatDate(row.lastLoginAt)}</td>
                      <td className={tdClass}>
                        <UserRowActions user={row} isSelf={row.id === actor?.id} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile card view (390px) */}
            <div className="sm:hidden space-y-3">
              {page.items.map(row => (
                <div key={row.id} className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] p-3 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <span className="block text-sm font-medium text-[var(--text)] truncate">{row.email}</span>
                      {row.name && row.name !== row.email && <span className="block text-xs text-[var(--text-muted)]">{row.name}</span>}
                    </div>
                    <div className="shrink-0 flex items-center gap-1">
                      <StatusPill tone={row.role === 'admin' ? 'ok' : 'muted'}>{row.role}</StatusPill>
                    </div>
                  </div>
                  <div className="flex items-center justify-between text-xs text-[var(--text-muted)]">
                    <span>Статус:</span>
                    {row.banned
                      ? <StatusPill tone="error">заблокирован</StatusPill>
                      : <StatusPill tone="muted">активен</StatusPill>}
                  </div>
                  <div className="flex items-center justify-between text-xs text-[var(--text-subtle)]">
                    <span>Регистрация:</span>
                    <span>{formatDate(row.createdAt)}</span>
                  </div>
                  <div className="pt-2 border-t border-[var(--border)]">
                    <UserRowActions user={row} isSelf={row.id === actor?.id} />
                  </div>
                </div>
              ))}
            </div>

            {page && (
              <Pagination
                page={page.page}
                pageSize={page.pageSize}
                total={page.total}
                basePath="/admin/users"
                params={{ q: query.q, role: query.role, status: query.status }}
              />
            )}
          </>
        )}
      </Card>
    </div>
  );
}
