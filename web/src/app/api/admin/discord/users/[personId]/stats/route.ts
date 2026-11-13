import { requireAdmin } from '../../../../../../../../lib/admin-guard';
import {
  USER_STATS_SPEC,
  buildCoreQuery,
  discordFailure,
  readDiscordUserStats,
} from '../../../../../../../../lib/admin-discord';
import { jsonError, jsonOk } from '../../../../../../../../lib/admin-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Статистика человека: сообщения, ходы, каналы и последние дни.
export async function GET(request: Request, context: { params: Promise<{ personId: string }> }) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const { personId } = await context.params;
  const id = personId.trim();
  if (!id || id.length > 120) return jsonError(400, 'bad_request', 'Некорректный идентификатор человека.');

  const parsed = buildCoreQuery(new URL(request.url).searchParams, USER_STATS_SPEC);
  if (!parsed.ok) return jsonError(400, 'bad_request', parsed.message);

  const result = await readDiscordUserStats(id, parsed.query);
  if (result.state !== 'ok') return discordFailure(result, 'Ядро не отдало статистику.');
  return jsonOk(result.data ?? {});
}
