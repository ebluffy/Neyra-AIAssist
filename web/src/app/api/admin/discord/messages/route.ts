import { requireAdmin } from '../../../../../../lib/admin-guard';
import {
  MESSAGE_SPEC,
  buildCoreQuery,
  discordFailure,
  readDiscordMessages,
} from '../../../../../../lib/admin-discord';
import { jsonError, jsonOk } from '../../../../../../lib/admin-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// История диалогов с Нейрой из chat_log: фильтры и курсор по id.
export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const parsed = buildCoreQuery(new URL(request.url).searchParams, MESSAGE_SPEC);
  if (!parsed.ok) return jsonError(400, 'bad_request', parsed.message);

  const result = await readDiscordMessages(parsed.query);
  if (result.state === 'unsupported') {
    return jsonOk({ supported: false, available: false, items: [], total: 0, message: result.message });
  }
  if (result.state !== 'ok') return discordFailure(result, 'Ядро не отдало историю.');
  return jsonOk(result.data ?? {});
}
