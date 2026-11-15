import { requireAdmin } from '../../../../../lib/admin-guard';
import { countUsers } from '../../../../../lib/admin-users';
import { countInvites } from '../../../../../lib/admin-invites';
import { countAuditSince } from '../../../../../lib/admin-audit';
import { coreGet, type CoreHealth } from '../../../../../lib/core-admin';
import { jsonError, jsonOk } from '../../../../../lib/admin-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [users, invites, audit24h, health] = await Promise.all([
      countUsers(),
      countInvites(),
      countAuditSince(since),
      coreGet<CoreHealth>('/v1/health', { timeoutMs: 3000 }),
    ]);
    return jsonOk({ users, invites, audit24h, core: { state: health.state, message: health.message ?? null } });
  } catch {
    return jsonError(503, 'db_unavailable', 'База сайта недоступна.');
  }
}
