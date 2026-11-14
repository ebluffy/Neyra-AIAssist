import { requireAdmin } from '../../../../../../../lib/admin-guard';
import {
  GUILD_DETAIL_SPEC,
  buildCoreQuery,
  discordFailure,
  discordPersonMap,
  fillDiscordPersonIds,
  readDiscordGuild,
} from '../../../../../../../lib/admin-discord';
import { jsonError, jsonOk } from '../../../../../../../lib/admin-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Один сервер: каналы и известные участники.
export async function GET(request: Request, context: { params: Promise<{ guildId: string }> }) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const { guildId } = await context.params;
  const id = guildId.trim();
  if (!id || id.length > 120) return jsonError(400, 'bad_request', 'Некорректный идентификатор сервера.');

  const parsed = buildCoreQuery(new URL(request.url).searchParams, GUILD_DETAIL_SPEC);
  if (!parsed.ok) return jsonError(400, 'bad_request', parsed.message);

  const [result, people] = await Promise.all([
    readDiscordGuild(id, parsed.query),
    discordPersonMap(),
  ]);
  if (result.state === 'unsupported') {
    return jsonOk({ supported: false, available: false, message: result.message });
  }
  if (result.state !== 'ok') return discordFailure(result, 'Ядро не отдало сервер.');
  const data = result.data;
  if (!data) return jsonOk({});
  return jsonOk({
    ...data,
    members: fillDiscordPersonIds(data.members ?? [], people),
  });
}
