import { listInvites, countInvites } from '../../../../lib/admin-invites';
import { parseInviteListQuery } from '../../../../lib/admin-rules';
import { InviteCreate } from '../../../components/admin/invite-create';
import { InviteRowActions } from '../../../components/admin/invite-row-actions';
import { Pagination } from '../../../components/admin/pagination';
import { Card, EmptyState, PageHeader, Stat, StatusPill, formatDate, tableClass, tdClass, thClass } from '../../../components/admin/ui';

export const dynamic = 'force-dynamic';

const fieldClass = 'rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1.5 text-sm text-[var(--text)] focus-visible:outline-none';

const stateTone = { active: 'ok', used: 'muted', expired: 'warn', revoked: 'error' } as const;
const stateLabel = { active: 'активен', used: 'использован', expired: 'истёк', revoked: 'отозван' } as const;

export default async function AdminInvitesPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = parseInviteListQuery(await searchParams);
  let page: Awaited<ReturnType<typeof listInvites>> | null = null;
  let counts: Awaited<ReturnType<typeof countInvites>> | null = null;
  let dbError = false;
  try {
    [page, counts] = await Promise.all([listInvites(query), countInvites()]);
  } catch {
    dbError = true;
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Приглашения"
        description="Регистрация на сайте — только по одноразовой ссылке. В базе хранится лишь хэш токена: ссылку нельзя восстановить, только создать новую."
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Всего" value={counts?.total ?? '—'} />
        <Stat label="Активные" value={counts?.active ?? '—'} />
        <Stat label="Использованы" value={counts?.used ?? '—'} />
      </div>

      <Card title="Новое приглашение" description="Ссылка показывается один раз. Передайте её лично: письма сайт не отправляет.">
        <InviteCreate />
      </Card>

      <Card>
        <form method="get" className="mb-4 flex flex-wrap items-end gap-2 border-b border-[var(--border)] pb-4">
          <label className="grid gap-1 text-xs text-[var(--text-muted)]">
            Состояние
            <select name="state" defaultValue={query.state} className={fieldClass}>
              <option value="all">все</option>
              <option value="active">активные</option>
              <option value="used">использованные</option>
              <option value="expired">истёкшие</option>
              <option value="revoked">отозванные</option>
            </select>
          </label>
          <button type="submit" className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-2)] px-3.5 py-1.5 text-sm font-medium text-[var(--text)] hover:bg-[var(--surface-3)] transition-colors">
            Показать
          </button>
        </form>

        {dbError ? (
          <EmptyState title="База сайта недоступна" text="Список не загрузился. Проверьте PostgreSQL и DATABASE_URL." />
        ) : !page || page.items.length === 0 ? (
          <EmptyState title="Приглашений нет" text="Создайте первое приглашение — без него зарегистрироваться нельзя." />
        ) : (
          <>
            {/* Desktop table view */}
            <div className="hidden sm:block overflow-x-auto">
              <table className={tableClass}>
                <thead>
                  <tr>
                    <th className={thClass}>Создано</th>
                    <th className={thClass}>Кем</th>
                    <th className={thClass}>Действует до</th>
                    <th className={thClass}>Состояние</th>
                    <th className={thClass}>Использовал</th>
                    <th className={thClass}>Действия</th>
                  </tr>
                </thead>
                <tbody>
                  {page.items.map(row => (
                    <tr key={row.id} className="hover:bg-[var(--surface-2)]">
                      <td className={`${tdClass} whitespace-nowrap text-xs text-[var(--text-muted)]`}>{formatDate(row.createdAt)}</td>
                      <td className={`${tdClass} text-xs text-[var(--text)]`}>{row.createdBy ?? '—'}</td>
                      <td className={`${tdClass} whitespace-nowrap text-xs text-[var(--text-muted)]`}>{formatDate(row.expiresAt)}</td>
                      <td className={tdClass}><StatusPill tone={stateTone[row.state]}>{stateLabel[row.state]}</StatusPill></td>
                      <td className={`${tdClass} text-xs`}>
                        {row.usedBy ? (
                          <>
                            <span className="block text-[var(--text)]">{row.usedBy}</span>
                            <span className="text-[var(--text-subtle)]">{formatDate(row.usedAt)}</span>
                          </>
                        ) : '—'}
                      </td>
                      <td className={tdClass}>
                        <InviteRowActions id={row.id} disabled={row.state !== 'active'} />
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
                  <div className="flex items-center justify-between">
                    <StatusPill tone={stateTone[row.state]}>{stateLabel[row.state]}</StatusPill>
                    <span className="text-xs text-[var(--text-subtle)]">{formatDate(row.createdAt)}</span>
                  </div>
                  <div className="text-xs text-[var(--text-muted)] flex justify-between">
                    <span>Действует до:</span>
                    <span>{formatDate(row.expiresAt)}</span>
                  </div>
                  {row.usedBy && (
                    <div className="text-xs text-[var(--text-muted)] flex justify-between">
                      <span>Использовал:</span>
                      <span className="text-[var(--text)]">{row.usedBy}</span>
                    </div>
                  )}
                  <div className="pt-2 border-t border-[var(--border)] flex justify-end">
                    <InviteRowActions id={row.id} disabled={row.state !== 'active'} />
                  </div>
                </div>
              ))}
            </div>

            {page && (
              <Pagination
                page={page.page}
                pageSize={page.pageSize}
                total={page.total}
                basePath="/admin/invites"
                params={{ state: query.state }}
              />
            )}
          </>
        )}
      </Card>
    </div>
  );
}
