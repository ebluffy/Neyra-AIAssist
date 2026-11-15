import { requireAdmin } from '../../../../../../lib/admin-guard';
import { discordFailure, readDiscordActivity } from '../../../../../../lib/admin-discord';
import { jsonError, jsonOk } from '../../../../../../lib/admin-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Сводка диалогов: каналы с историей и люди, которые писали Нейре.
export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;

  const raw = (new URL(request.url).searchParams.get('guild_id') ?? '').trim();
  if (raw.length > 120) return jsonError(400, 'bad_request', 'Некорректный идентификатор сервера.');

  const result = await readDiscordActivity(raw || undefined);
  if (result.state === 'unsupported') {
    return jsonOk({ supported: false, available: false, channels: [], people: [], scanned: 0, truncated: false, message: result.message });
  }
  if (result.state !== 'ok') return discordFailure(result, 'Ядро не отдало сводку диалогов.');
  return jsonOk(result.data ?? {});
}
