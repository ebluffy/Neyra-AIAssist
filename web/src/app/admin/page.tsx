import Link from 'next/link';
import { countUsers } from '../../../lib/admin-users';
import { countInvites } from '../../../lib/admin-invites';
import { countAuditSince } from '../../../lib/admin-audit';
import { coreGet, type CoreHealth } from '../../../lib/core-admin';
import { Card, PageHeader, Stat, StatusPill, formatDuration, formatDate } from '../../components/admin/ui';

export const dynamic = 'force-dynamic';

const sections = [
  { href: '/admin/users', title: 'Пользователи', text: 'Роли, блокировка, сброс пароля, удаление.' },
  { href: '/admin/invites', title: 'Приглашения', text: 'Одноразовые ссылки на регистрацию.' },
  { href: '/admin/models', title: 'Модели', text: 'Провайдер и модель по лейнам — чтение.' },
  { href: '/admin/prompts', title: 'Промпты и персона', text: 'Состояние API ядра.' },
  { href: '/admin/memory', title: 'Память', text: 'Люди и статистика из ядра.' },
  { href: '/admin/files', title: 'Файлы', text: 'Вложения и их доступность.' },
  { href: '/admin/integrations', title: 'Интеграции', text: 'Discord, провайдеры, MCP.' },
  { href: '/admin/logs', title: 'Журналы', text: 'Аудит админки и операции ядра.' },
  { href: '/admin/system', title: 'Система', text: 'Здоровье, версия, диск, перезапуск.' },
];

export default async function AdminOverview() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [users, invites, audit24h, health] = await Promise.all([
    countUsers().catch(() => null),
    countInvites().catch(() => null),
    countAuditSince(since).catch(() => null),
    coreGet<CoreHealth>('/v1/health', { timeoutMs: 3000 }),
  ]);
  const coreTone = health.state === 'ok' ? (health.data?.ok ? 'ok' : 'warn') : health.state === 'unconfigured' ? 'muted' : 'error';
  const coreLabel = health.state === 'ok'
    ? (health.data?.ok ? 'Ядро в норме' : 'Ядро деградировало')
    : health.state === 'unconfigured'
      ? 'Ядро не подключено'
      : 'Ядро недоступно';

  return (
    <div className="space-y-6">
      <PageHeader title="Обзор" description="Состояние сайта и ядра. Все действия разделов пишутся в журнал." />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Пользователи" value={users?.total ?? '—'} hint={users ? `админов: ${users.admins} · заблокировано: ${users.banned}` : 'база недоступна'} />
        <Stat label="Активные приглашения" value={invites?.active ?? '—'} hint={invites ? `использовано: ${invites.used} из ${invites.total}` : 'база недоступна'} />
        <Stat label="Действия за сутки" value={audit24h ?? '—'} hint="записи журнала админки" />
        <div className="rounded-[var(--radius)] border border-[var(--border)] px-4 py-3">
          <p className="text-xs text-[var(--muted)]">Ядро</p>
          <div className="mt-2"><StatusPill tone={coreTone}>{coreLabel}</StatusPill></div>
          <p className="mt-2 text-xs text-[var(--muted)]">
            {health.state === 'ok'
              ? `версия ${health.data?.version ?? health.data?.api_version ?? '—'} · uptime ${formatDuration(health.data?.uptime_seconds)}`
              : health.message ?? '—'}
          </p>
        </div>
      </div>

      <Card title="Разделы" description="Настройки ядра пока только для чтения: запись включим после API ядра.">
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

      <Card title="Здоровье ядра" description={health.state === 'ok' ? 'Данные из /v1/health ядра.' : health.message ?? ''}>
        {health.state === 'ok' && Array.isArray(health.data?.checks) && health.data.checks.length > 0 ? (
          <ul className="space-y-1 text-sm">
            {health.data.checks.map((check, index) => (
              <li key={`${check.name ?? 'check'}-${index}`} className="flex items-center justify-between gap-3 border-b border-[var(--border)] py-1.5 last:border-0">
                <span>{check.name ?? 'проверка'}</span>
                <span className="flex items-center gap-2 text-xs text-[var(--muted)]">
                  {check.reason && <span>{check.reason}</span>}
                  <StatusPill tone={check.ok ? 'ok' : 'error'}>{check.ok ? 'ок' : 'сбой'}</StatusPill>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-[var(--muted)]">
            {health.state === 'ok' ? 'Ядро не вернуло список проверок.' : health.message ?? 'Нет данных.'}
          </p>
        )}
        <p className="mt-3 text-xs text-[var(--muted)]">Проверено: {formatDate(new Date())}</p>
      </Card>
    </div>
  );
}
