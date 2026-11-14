import { requireAdmin } from '../../../../../../../../lib/admin-guard';
import { MCP_NAME_RE, describeMcpError, restartMcpServer } from '../../../../../../../../lib/admin-mcp';
import { recordAudit } from '../../../../../../../../lib/admin-audit';
import { jsonError, jsonOk } from '../../../../../../../../lib/admin-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const IDENTITY_ERROR = 'Не настроен identity-токен сайта: проверьте NEYRA_IDENTITY_JWT_SECRET и NEYRA_IDENTITY_JWT_ISSUER.';

// Переподключить один сервер; остальные не трогаются.
export async function POST(request: Request, context: { params: Promise<{ name: string }> }) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const { name } = await context.params;
  if (!MCP_NAME_RE.test(name)) {
    return jsonError(400, 'invalid_mcp', 'Некорректное имя сервера.');
  }

  let result;
  try {
    result = await restartMcpServer(auth.user, name);
  } catch {
    return jsonError(503, 'identity_unconfigured', IDENTITY_ERROR);
  }
  if (result.state !== 'ok' || !result.data) {
    const mapped = describeMcpError(result);
    return jsonError(mapped.status, mapped.error, mapped.message);
  }
  await recordAudit(auth.user, 'mcp.server.restart', { type: 'mcp', id: name }, {});
  return jsonOk(result.data);
}
