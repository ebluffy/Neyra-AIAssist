import { requireAdmin } from '../../../../../lib/admin-guard';
import { listAudit, parseAuditQuery } from '../../../../../lib/admin-audit';
import { coreGet } from '../../../../../lib/core-admin';
import { jsonError, jsonOk } from '../../../../../lib/admin-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface CoreAuditItem {
  ts?: string;
  op?: string;
  role?: string;
  trace_id?: string;
}

// Журнал админки (наша таблица) + последние операции ядра (если ключ сайта имеет роль maint).
export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  try {
    const query = parseAuditQuery(new URL(request.url).searchParams);
    const [items, core] = await Promise.all([
      listAudit(query),
      coreGet<{ items?: CoreAuditItem[] }>('/v1/audit/recent?limit=50', { timeoutMs: 3000 }),
    ]);
    return jsonOk({
      items,
      core: {
        state: core.state,
        message: core.message ?? null,
        items: core.state === 'ok' ? (core.data?.items ?? []) : [],
      },
    });
  } catch {
    return jsonError(503, 'db_unavailable', 'База сайта недоступна.');
  }
}
