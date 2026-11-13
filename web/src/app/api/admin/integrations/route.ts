import { requireAdmin } from '../../../../../lib/admin-guard';
import { readAdminConfig } from '../../../../../lib/admin-config';
import { coreGet, type CoreHealth } from '../../../../../lib/core-admin';
import { jsonError, jsonOk } from '../../../../../lib/admin-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Интеграции: только статусы и публичные поля конфига. Секреты — флагом,
// значения ключей не отдаются ни в каком виде.
export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;

  const [config, health] = await Promise.all([
    readAdminConfig(),
    coreGet<CoreHealth>('/v1/health', { timeoutMs: 4000 }),
  ]);

  if (config.state !== 'ok' || !config.data) {
    return jsonError(
      503,
      config.state === 'unconfigured' ? 'core_unconfigured' : 'core_unavailable',
      config.message ?? 'Ядро не отдало конфиг интеграций.',
    );
  }

  return jsonOk({
    discord: {
      configured: Boolean(process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET),
      client_id_present: Boolean(process.env.DISCORD_CLIENT_ID),
      secret_present: Boolean(process.env.DISCORD_CLIENT_SECRET),
    },
    providers: config.data.providers,
    lanes: config.data.lanes,
    mcp: config.data.mcp,
    secrets: config.data.secrets,
    editable: config.data.editable,
    core: {
      state: health.state,
      version: health.state === 'ok' ? health.data?.version ?? health.data?.api_version ?? null : null,
      providers: health.state === 'ok' ? health.data?.llm_providers ?? [] : [],
      message: health.message ?? null,
    },
  });
}
