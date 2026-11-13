import { requireAdmin } from '../../../../../lib/admin-guard';
import { coreGet, type CoreHealth } from '../../../../../lib/core-admin';
import { jsonOk } from '../../../../../lib/admin-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Интеграции: Discord (по наличию настроек в .env сайта), провайдеры моделей (из здоровья ядра),
// MCP (у ядра нет API управления). Секреты не показываются — только «настроен / не настроен».
export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const health = await coreGet<CoreHealth>('/v1/health', { timeoutMs: 4000 });
  const discordConfigured = Boolean(
    (process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET) || process.env.DISCORD_ENABLED === 'true',
  );
  return jsonOk({
    discord: {
      configured: discordConfigured,
      note: discordConfigured
        ? 'Вход через Discord настроен в .env сайта.'
        : 'Вход через Discord не настроен: нет DISCORD_CLIENT_ID и DISCORD_CLIENT_SECRET.',
    },
    providers: {
      state: health.state,
      message: health.message ?? null,
      names: health.state === 'ok' ? (health.data?.llm_providers ?? []) : [],
    },
    mcp: {
      state: 'no_api',
      message: 'У ядра нет API управления MCP-серверами: список и переключатели появятся вместе с ним.',
    },
  });
}
