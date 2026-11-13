import { listAudit, parseAuditQuery } from '../../../../lib/admin-audit';
import { coreGet } from '../../../../lib/core-admin';
import { Card, EmptyState, PageHeader, StatusPill, formatDate, tableClass, tdClass, thClass } from '../../../components/admin/ui';

export const dynamic = 'force-dynamic';

interface CoreAuditItem {
  ts?: string;
  op?: string;
  role?: string;
  trace_id?: string;
}

const fieldClass = 'rounded-[var(--radius)] border border-[var(--border)] bg-transparent px-2 py-1.5 text-sm';

const actionLabels: Record<string, string> = {
  'user.role_change': 'Смена роли',
  'user.ban': 'Блокировка',
  'user.unban': 'Разблокировка',
  'user.delete': 'Удаление пользователя',
  'user.password_reset': 'Сброс пароля',
  'invite.create': 'Создание приглашения',
  'invite.revoke': 'Отзыв приглашения',
  'system.restart': 'Перезапуск ядра',
};

export default async function AdminLogsPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const period = typeof params.period === 'string' ? params.period : '24h';
  const action = typeof params.action === 'string' ? params.action : '';
  const windowMs = period === '1h' ? 3600_000 : period === '7d' ? 7 * 86400_000 : period === 'all' ? 0 : 86400_000;
  const query = parseAuditQuery({
    action,
    limit: '100',
    since: windowMs ? new Date(Date.now() - windowMs).toISOString() : '',
  });

  let rows: Awaited<ReturnType<typeof listAudit>> = [];
  let dbError = false;
  try {
    rows = await listAudit(query);
  } catch {
    dbError = true;
  }
  const core = await coreGet<{ items?: CoreAuditItem[] }>('/v1/audit/recent?limit=50', { timeoutMs: 3000 });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Журналы"
        description="Действия админки пишутся в базу сайта. Операции ядра показываются отдельно и только при ключе с ролью maint."
      />

      <Card>
        <form method="get" className="mb-4 flex flex-wrap items-end gap-2">
          <label className="grid gap-1 text-xs">
            Период
            <select name="period" defaultValue={period} className={fieldClass}>
              <option value="1h">за час</option>
              <option value="24h">за сутки</option>
              <option value="7d">за 7 дней</option>
              <option value="all">всё время</option>
            </select>
          </label>
          <label className="grid gap-1 text-xs">
            Действие
            <select name="action" defaultValue={action} className={fieldClass}>
              <option value="">все</option>
              {Object.entries(actionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <button type="submit" className="rounded-[var(--radius)] border border-[var(--border)] px-3 py-1.5 text-sm bg-[var(--surface-2)] text-[var(--text)] hover:bg-[var(--surface-3)] font-medium">
            Показать
          </button>
        </form>

        {dbError ? (
          <EmptyState title="База сайта недоступна" text="Журнал не загрузился. Проверьте PostgreSQL и DATABASE_URL." />
        ) : rows.length === 0 ? (
          <EmptyState title="Записей нет" text="За выбранный период действий не было." />
        ) : (
          <div className="overflow-x-auto">
            <table className={tableClass}>
              <thead>
                <tr>
                  <th className={thClass}>Время</th>
                  <th className={thClass}>Кто</th>
                  <th className={thClass}>Действие</th>
                  <th className={thClass}>Объект</th>
                  <th className={thClass}>Детали</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr key={row.id}>
                    <td className={`${tdClass} whitespace-nowrap text-xs text-[var(--muted)]`}>{formatDate(row.createdAt)}</td>
                    <td className={`${tdClass} text-xs`}>{row.actorEmail}</td>
                    <td className={tdClass}>
                      <span className="block text-sm">{actionLabels[row.action] ?? row.action}</span>
                      <span className="font-mono text-xs text-[var(--muted)]">{row.action}</span>
                    </td>
                    <td className={`${tdClass} text-xs`}>
                      {row.targetType ? `${row.targetType}: ${row.targetId ?? '—'}` : '—'}
                    </td>
                    <td className={`${tdClass} text-xs`}>
                      {row.details && Object.keys(row.details).length > 0
                        ? <code className="font-mono">{JSON.stringify(row.details)}</code>
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Операции ядра" description="Источник: GET /v1/audit/recent. Только время, операция, роль и trace_id.">
        {core.state !== 'ok' ? (
          <div className="flex items-center gap-3">
            <StatusPill tone={core.state === 'unconfigured' ? 'muted' : 'warn'}>{core.state === 'unconfigured' ? 'ядро не подключено' : 'недоступно'}</StatusPill>
            <p className="text-xs text-[var(--muted)]">{core.message ?? 'Ядро не вернуло журнал.'}</p>
          </div>
        ) : (core.data?.items ?? []).length === 0 ? (
          <p className="text-xs text-[var(--muted)]">Ядро не вернуло записей.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className={tableClass}>
              <thead>
                <tr>
                  <th className={thClass}>Время</th>
                  <th className={thClass}>Операция</th>
                  <th className={thClass}>Роль</th>
                  <th className={thClass}>Trace</th>
                </tr>
              </thead>
              <tbody>
                {(core.data?.items ?? []).map((item, index) => (
                  <tr key={`${item.trace_id ?? 'row'}-${index}`}>
                    <td className={`${tdClass} whitespace-nowrap text-xs text-[var(--muted)]`}>{formatDate(item.ts ?? null)}</td>
                    <td className={`${tdClass} text-sm`}>{item.op ?? '—'}</td>
                    <td className={`${tdClass} text-xs`}>{item.role ?? '—'}</td>
                    <td className={`${tdClass} font-mono text-xs text-[var(--muted)]`}>{item.trace_id ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
