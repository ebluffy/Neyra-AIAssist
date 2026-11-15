import { listInvites, countInvites } from '../../../../lib/admin-invites';
import { parseInviteListQuery } from '../../../../lib/admin-rules';
import { InviteCreate } from '../../../components/admin/invite-create';
import { InviteRowActions } from '../../../components/admin/invite-row-actions';
import { Pagination } from '../../../components/admin/pagination';
import { Card, EmptyState, PageHeader, Stat, StatusPill, formatDate, tableClass, tdClass, thClass } from '../../../components/admin/ui';

export const dynamic = 'force-dynamic';

const fieldClass = 'rounded-[var(--radius)] border border-[var(--border)] bg-transparent px-2 py-1.5 text-sm';

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
        <form method="get" className="mb-4 flex flex-wrap items-end gap-2">
          <label className="grid gap-1 text-xs">
            Состояние
            <select name="state" defaultValue={query.state} className={fieldClass}>
              <option value="all">все</option>
              <option value="active">активные</option>
              <option value="used">использованные</option>
              <option value="expired">истёкшие</option>
              <option value="revoked">отозванные</option>
            </select>
          </label>
          <button type="submit" className="rounded-[var(--radius)] border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-white/5">
            Показать
          </button>
        </form>

        {dbError ? (
          <EmptyState title="База сайта недоступна" text="Список не загрузился. Проверьте PostgreSQL и DATABASE_URL." />
        ) : !page || page.items.length === 0 ? (
          <EmptyState title="Приглашений нет" text="Создайте первое приглашение — без него зарегистрироваться нельзя." />
        ) : (
          <div className="overflow-x-auto">
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
                  <tr key={row.id}>
                    <td className={`${tdClass} whitespace-nowrap text-xs text-[var(--muted)]`}>{formatDate(row.createdAt)}</td>
                    <td className={`${tdClass} text-xs`}>{row.createdBy ?? '—'}</td>
                    <td className={`${tdClass} whitespace-nowrap text-xs text-[var(--muted)]`}>{formatDate(row.expiresAt)}</td>
                    <td className={tdClass}><StatusPill tone={stateTone[row.state]}>{stateLabel[row.state]}</StatusPill></td>
                    <td className={`${tdClass} text-xs`}>
                      {row.usedBy ? (
                        <>
                          <span className="block">{row.usedBy}</span>
                          <span className="text-[var(--muted)]">{formatDate(row.usedAt)}</span>
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
        )}

        {page && (
          <Pagination
            page={page.page}
            pageSize={page.pageSize}
            total={page.total}
            basePath="/admin/invites"
            params={{ state: query.state }}
          />
        )}
      </Card>
    </div>
  );
}
