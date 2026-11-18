import { requireAdmin } from '../../../../../../lib/admin-guard';
import {
  GUILD_LIST_SPEC,
  buildCoreQuery,
  discordCoreStatus,
  readDiscordGuilds,
} from '../../../../../../lib/admin-discord';
import { jsonError, jsonOk } from '../../../../../../lib/admin-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Прокси к ядру: только чтение каталога, роль проверяется на сервере.
export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const parsed = buildCoreQuery(new URL(request.url).searchParams, GUILD_LIST_SPEC);
  if (!parsed.ok) return jsonError(400, 'bad_request', parsed.message);

  const result = await readDiscordGuilds(parsed.query);
  if (result.state === 'unsupported') {
    return jsonOk({ supported: false, available: false, items: [], total: 0, message: result.message });
  }
  if (result.state !== 'ok') {
    return jsonError(
      discordCoreStatus(result),
      result.state === 'unconfigured' ? 'core_unconfigured' : 'core_unavailable',
      result.message ?? 'Ядро не отдало каталог серверов.',
    );
  }
  return jsonOk(result.data ?? {});
}
