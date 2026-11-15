import { coreGet, type CoreHealth, type CoreMeta } from '../../../../lib/core-admin';
import { readBackups, readDiskUsage } from '../../../../lib/admin-system';
import { RestartCore } from '../../../components/admin/restart-core';
import { Card, EmptyState, PageHeader, Stat, StatusPill, formatBytes, formatDate, formatDuration, tableClass, tdClass, thClass } from '../../../components/admin/ui';

export const dynamic = 'force-dynamic';

interface ReadyReport {
  ok?: boolean;
  checks?: Array<{ name?: string; ok?: boolean; reason?: string }>;
}

export default async function AdminSystemPage() {
  const [health, ready, meta, disk, backups] = await Promise.all([
    coreGet<CoreHealth>('/v1/health', { timeoutMs: 4000 }),
    coreGet<ReadyReport>('/v1/health/ready', { timeoutMs: 4000 }),
    coreGet<CoreMeta>('/v1/meta', { timeoutMs: 3000 }),
    readDiskUsage(),
    readBackups(process.env.NEYRA_BACKUP_DIR),
  ]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Система"
        description="Здоровье ядра и сайта, версия, диск, бэкапы. Перезапуск ядра — с подтверждением и записью в журнал."
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Uptime сайта" value={formatDuration(process.uptime())} hint="процесс Next" />
        <Stat label="Диск свободно" value={disk ? formatBytes(disk.freeBytes) : '—'} hint={disk ? `из ${formatBytes(disk.totalBytes)}` : 'не удалось прочитать'} />
        <Stat label="Версия сайта" value={process.env.NEYRA_WEB_VERSION ?? '—'} hint="задаётся сборкой" />
        <Stat label="Коммит" value={process.env.NEYRA_COMMIT ? process.env.NEYRA_COMMIT.slice(0, 12) : '—'} hint="если сборка сообщает" />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Ядро" description={health.state === 'ok' ? 'GET /v1/health' : health.message ?? ''}>
          {health.state !== 'ok' ? (
            <EmptyState title="Ядро недоступно" text={health.message ?? 'Проверьте NEYRA_API_URL и NEYRA_SERVICE_KEY в .env сайта.'} />
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill tone={health.data?.ok ? 'ok' : 'warn'}>{health.data?.ok ? 'в норме' : 'деградировало'}</StatusPill>
                <span className="text-xs text-[var(--muted)]">
                  версия {health.data?.version ?? health.data?.api_version ?? '—'} · uptime {formatDuration(health.data?.uptime_seconds)}
                </span>
              </div>
              {health.data?.degraded_reason && <p className="text-xs text-amber-300">{health.data.degraded_reason}</p>}
              {Array.isArray(health.data?.checks) && health.data.checks.length > 0 ? (
                <ul className="space-y-1 text-sm">
                  {health.data.checks.map((check, index) => (
                    <li key={`${check.name ?? 'check'}-${index}`} className="flex items-center justify-between gap-3 border-b border-[var(--border)] py-1.5 last:border-0">
                      <span>{check.name ?? 'проверка'}</span>
                      <span className="flex items-center gap-2 text-xs text-[var(--muted)]">
                        {check.reason && <span>{check.reason}</span>}
                        {typeof check.ms === 'number' && <span>{check.ms} мс</span>}
                        <StatusPill tone={check.ok ? 'ok' : 'error'}>{check.ok ? 'ок' : 'сбой'}</StatusPill>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-xs text-[var(--muted)]">Ядро не вернуло список проверок.</p>}
              {Array.isArray(health.data?.llm_providers) && health.data.llm_providers.length > 0 && (
                <p className="text-xs text-[var(--muted)]">Провайдеры: {health.data.llm_providers.join(', ')}</p>
              )}
            </div>
          )}
        </Card>

        <Card title="Готовность" description={ready.state === 'ok' ? 'GET /v1/health/ready' : ready.message ?? ''}>
          {ready.state !== 'ok' ? (
            <p className="text-xs text-[var(--muted)]">{ready.message ?? 'Ядро не ответило.'}</p>
          ) : (ready.data?.checks ?? []).length === 0 ? (
            <p className="text-xs text-[var(--muted)]">Проверок нет.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {(ready.data?.checks ?? []).map((check, index) => (
                <li key={`${check.name ?? 'ready'}-${index}`} className="flex items-center justify-between gap-3 border-b border-[var(--border)] py-1.5 last:border-0">
                  <span>{check.name ?? 'проверка'}</span>
                  <span className="flex items-center gap-2 text-xs text-[var(--muted)]">
                    {check.reason && <span>{check.reason}</span>}
                    <StatusPill tone={check.ok ? 'ok' : 'error'}>{check.ok ? 'ок' : 'сбой'}</StatusPill>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Метаданные ядра" description={meta.state === 'ok' ? 'GET /v1/meta' : meta.message ?? ''}>
          {meta.state !== 'ok' ? (
            <p className="text-xs text-[var(--muted)]">{meta.message ?? 'Ядро не ответило.'}</p>
          ) : (
            <dl className="grid gap-1 text-sm">
              <div className="flex justify-between gap-3"><dt className="text-[var(--muted)]">API</dt><dd className="font-mono text-xs">{meta.data?.api_version ?? '—'}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-[var(--muted)]">Публичный адрес</dt><dd className="font-mono text-xs">{meta.data?.public_url ?? '—'}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-[var(--muted)]">Сайт</dt><dd className="font-mono text-xs">{meta.data?.dashboard_url ?? '—'}</dd></div>
            </dl>
          )}
        </Card>

        <Card title="Бэкапы" description="Создание бэкапа — только по согласованию на сервере; панель его не запускает.">
          {!backups.configured ? (
            <p className="text-xs text-[var(--muted)]">NEYRA_BACKUP_DIR не задан — список бэкапов недоступен.</p>
          ) : backups.items.length === 0 ? (
            <p className="text-xs text-[var(--muted)]">В каталоге бэкапов пусто или он недоступен на чтение.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className={tableClass}>
                <thead>
                  <tr><th className={thClass}>Файл</th><th className={thClass}>Размер</th><th className={thClass}>Изменён</th></tr>
                </thead>
                <tbody>
                  {backups.items.slice(0, 20).map(item => (
                    <tr key={item.name}>
                      <td className={`${tdClass} font-mono text-xs`}>{item.name}</td>
                      <td className={`${tdClass} text-xs`}>{formatBytes(item.size)}</td>
                      <td className={`${tdClass} whitespace-nowrap text-xs text-[var(--muted)]`}>{formatDate(item.modifiedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <Card title="Перезапуск" description="Ядро — мягкая остановка через API. Сайт перезапускается deploy-скриптом на сервере.">
        <RestartCore />
        <p className="mt-3 text-xs text-[var(--muted)]">
          Перезапуск сайта с панели недоступен: у пользователя сайта нет доступа к systemd. Раздел вернётся, когда появится отдельный сервис управления.
        </p>
      </Card>
    </div>
  );
}
