import { requireAdmin } from '../../../../../../lib/admin-guard';
import {
  MEMBER_SPEC,
  buildCoreQuery,
  discordFailure,
  discordPersonMap,
  fillDiscordPersonIds,
  readDiscordMembers,
} from '../../../../../../lib/admin-discord';
import { jsonError, jsonOk } from '../../../../../../lib/admin-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Участники каталога: фильтр по серверу и поиск по нику/имени/id.
export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const parsed = buildCoreQuery(new URL(request.url).searchParams, MEMBER_SPEC);
  if (!parsed.ok) return jsonError(400, 'bad_request', parsed.message);

  const [result, people] = await Promise.all([
    readDiscordMembers(parsed.query),
    discordPersonMap(),
  ]);
  if (result.state !== 'ok') return discordFailure(result, 'Ядро не отдало участников.');
  const data = result.data;
  if (!data) return jsonOk({});
  return jsonOk({
    ...data,
    items: fillDiscordPersonIds(data.items ?? [], people),
  });
}
