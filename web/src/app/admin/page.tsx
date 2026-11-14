import Link from 'next/link';
import { countUsers } from '../../../lib/admin-users';
import { countInvites } from '../../../lib/admin-invites';
import { countAuditSince } from '../../../lib/admin-audit';
import { coreGet, coreGetReady } from '../../../lib/core-admin';
import { describeCoreHealth, describeReady, reasonText, type HealthReport, type ReadyReport } from '../../../lib/core-status';
import { Card, PageHeader, Stat, StatusPill, formatDuration, formatDate } from '../../components/admin/ui';

export const dynamic = 'force-dynamic';

const sections = [
  { href: '/admin/users', title: 'Пользователи', text: 'Роли, блокировка, сброс пароля, удаление.' },
  { href: '/admin/invites', title: 'Приглашения', text: 'Одноразовые ссылки на регистрацию.' },
  { href: '/admin/models', title: 'Модели', text: 'Провайдер, модель и лимиты по лейнам.' },
  { href: '/admin/prompts', title: 'Промпты и персона', text: 'Состояние API ядра.' },
  { href: '/admin/memory', title: 'Память', text: 'Люди, лимиты и автосжатие.' },
  { href: '/admin/files', title: 'Файлы', text: 'Вложения и их доступность.' },
  { href: '/admin/integrations', title: 'Интеграции', text: 'Discord, провайдеры, MCP.' },
  { href: '/admin/logs', title: 'Журналы', text: 'Аудит админки, операции и лог ядра.' },
  { href: '/admin/system', title: 'Система', text: 'Здоровье, версия, диск, перезапуск.' },
];

export default async function AdminOverview() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [users, invites, audit24h, health, ready] = await Promise.all([
    countUsers().catch(() => null),
    countInvites().catch(() => null),
    countAuditSince(since).catch(() => null),
    coreGet<HealthReport>('/v1/health', { timeoutMs: 3000 }),
    coreGetReady<ReadyReport>('/v1/health/ready', { timeoutMs: 3000 }),
  ]);
  const core = describeCoreHealth(health);
  const readiness = describeReady(ready);

  return (
    <div className="space-y-6">
      <PageHeader title="Обзор" description="Состояние сайта и ядра. Все действия разделов пишутся в журнал." />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Пользователи" value={users?.total ?? '—'} hint={users ? `админов: ${users.admins} · заблокировано: ${users.banned}` : 'база недоступна'} />
        <Stat label="Активные приглашения" value={invites?.active ?? '—'} hint={invites ? `использовано: ${invites.used} из ${invites.total}` : 'база недоступна'} />
        <Stat label="Действия за сутки" value={audit24h ?? '—'} hint="записи журнала админки" />
        <div className="rounded-[var(--radius)] border border-[var(--border)] px-4 py-3">
          <p className="text-xs text-[var(--muted)]">Ядро</p>
          <div className="mt-2"><StatusPill tone={core.tone}>{core.label}</StatusPill></div>
          <p className="mt-2 text-xs text-[var(--muted)]">
            {core.reason
              ?? (health.state === 'ok'
                ? `версия ${health.data?.version ?? health.data?.api_version ?? '—'} · uptime ${formatDuration(health.data?.uptime_seconds)}`
                : '—')}
          </p>
        </div>
      </div>

      <Card title="Разделы">
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {sections.map(section => (
            <li key={section.href}>
              <Link href={section.href} className="block rounded-[var(--radius)] border border-[var(--border)] px-3 py-2 hover:bg-white/5">
                <span className="text-sm font-medium">{section.title}</span>
                <span className="mt-0.5 block text-xs text-[var(--muted)]">{section.text}</span>
              </Link>
            </li>
          ))}
        </ul>
      </Card>

      <Card
        title="Готовность ядра"
        description={ready.state === 'ok' ? 'Источник: GET /v1/health/ready. Каждая проверка со своей причиной.' : ready.message ?? ''}
        footer={<span className="flex items-center gap-2"><StatusPill tone={readiness.tone}>{readiness.label}</StatusPill>{readiness.reason ?? ''}</span>}
      >
        {readiness.checks.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">{readiness.reason ?? 'Ядро не вернуло проверок.'}</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {readiness.checks.map((check, index) => (
              <li key={`${check.name ?? 'check'}-${index}`} className="flex items-center justify-between gap-3 border-b border-[var(--border)] py-1.5 last:border-0">
                <span>{check.name ?? 'проверка'}</span>
                <span className="flex items-center gap-2 text-xs text-[var(--muted)]">
                  {reasonText(check.reason) && <span>{reasonText(check.reason)}</span>}
                  {typeof check.ms === 'number' && <span>{check.ms} мс</span>}
                  <StatusPill tone={check.ok ? 'ok' : 'error'}>{check.ok ? 'ок' : 'сбой'}</StatusPill>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Здоровье ядра" description="Источник: GET /v1/health. Деградация видна и тогда, когда /v1/models ещё отвечает 200.">
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill tone={core.tone}>{core.label}</StatusPill>
          <span className="text-xs text-[var(--muted)]">
            {health.state === 'ok'
              ? `версия ${health.data?.version ?? health.data?.api_version ?? '—'} · uptime ${formatDuration(health.data?.uptime_seconds)}`
              : health.message ?? '—'}
          </span>
        </div>
        {core.reason && <p className="mt-2 text-sm text-[var(--text-muted)]">{core.reason}</p>}
        <p className="mt-3 text-xs text-[var(--muted)]">Проверено: {formatDate(new Date())}</p>
      </Card>
    </div>
  );
}
