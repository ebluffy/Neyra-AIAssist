import { requireAdmin } from '../../../../../../lib/admin-guard';
import { describeMcpError, reloadMcpServers } from '../../../../../../lib/admin-mcp';
import { recordAudit } from '../../../../../../lib/admin-audit';
import { jsonError, jsonOk } from '../../../../../../lib/admin-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const IDENTITY_ERROR = 'Не настроен identity-токен сайта: проверьте NEYRA_IDENTITY_JWT_SECRET и NEYRA_IDENTITY_JWT_ISSUER.';

// Перечитать config/modules.yaml и переподключить все серверы. Рестарт ядра не нужен.
export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;

  let result;
  try {
    result = await reloadMcpServers(auth.user);
  } catch {
    return jsonError(503, 'identity_unconfigured', IDENTITY_ERROR);
  }
  if (result.state !== 'ok' || !result.data) {
    const mapped = describeMcpError(result);
    return jsonError(mapped.status, mapped.error, mapped.message);
  }
  await recordAudit(auth.user, 'mcp.reload', null, {});
  return jsonOk(result.data);
}
