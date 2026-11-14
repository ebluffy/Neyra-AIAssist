import { coreGet, type CoreHealth } from '../../../../lib/core-admin';
import { Card, PageHeader, StatusPill } from '../../../components/admin/ui';

export const dynamic = 'force-dynamic';

export default async function AdminIntegrationsPage() {
  const health = await coreGet<CoreHealth>('/v1/health', { timeoutMs: 4000 });
  const discordConfigured = Boolean(
    (process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET) || process.env.DISCORD_ENABLED === 'true',
  );
  const providers = health.state === 'ok' ? health.data?.llm_providers ?? [] : [];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Интеграции"
        description="Статус подключений. Секреты показываются только как «настроен / не настроен», значения не отдаются."
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Discord" description="Вход на сайт через Discord.">
          <StatusPill tone={discordConfigured ? 'ok' : 'muted'}>{discordConfigured ? 'настроен' : 'не настроен'}</StatusPill>
          <p className="mt-2 text-xs text-[var(--muted)]">
            {discordConfigured
              ? 'DISCORD_CLIENT_ID и DISCORD_CLIENT_SECRET заданы в .env сайта. Значения здесь не показываются.'
              : 'Нет DISCORD_CLIENT_ID и DISCORD_CLIENT_SECRET — кнопка входа через Discord не отображается.'}
          </p>
        </Card>

        <Card title="Провайдеры моделей" description="Источник: /v1/health ядра.">
          {health.state !== 'ok' ? (
            <p className="text-xs text-[var(--muted)]">{health.message ?? 'Ядро недоступно.'}</p>
          ) : providers.length === 0 ? (
            <p className="text-xs text-[var(--muted)]">Ядро не вернуло список провайдеров.</p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {providers.map(name => <li key={name}><StatusPill tone="ok">{name}</StatusPill></li>)}
            </ul>
          )}
          <p className="mt-2 text-xs text-[var(--muted)]">Ключи провайдеров хранятся в конфиге ядра и через сайт не читаются.</p>
        </Card>

        <Card title="MCP-серверы" description="Подключения инструментов ядра.">
          <StatusPill tone="warn">нет API ядра</StatusPill>
          <p className="mt-2 text-xs text-[var(--muted)]">
            У ядра нет API управления MCP-серверами. Список и переключатели появятся вместе с ним; сейчас раздел ничего не меняет.
          </p>
        </Card>
      </div>
    </div>
  );
}
