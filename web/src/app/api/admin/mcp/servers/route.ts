import { requireAdmin } from '../../../../../../lib/admin-guard';
import { createMcpServer, describeMcpError, readMcpServers, validateMcpApiBody } from '../../../../../../lib/admin-mcp';
import { recordAudit } from '../../../../../../lib/admin-audit';
import { jsonError, jsonOk, readJson } from '../../../../../../lib/admin-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const IDENTITY_ERROR = 'Не настроен identity-токен сайта: проверьте NEYRA_IDENTITY_JWT_SECRET и NEYRA_IDENTITY_JWT_ISSUER.';

// Список MCP-серверов с живым статусом. Значения env ядро не отдаёт.
export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;

  let result;
  try {
    result = await readMcpServers(auth.user);
  } catch {
    return jsonError(503, 'identity_unconfigured', IDENTITY_ERROR);
  }
  if (result.state !== 'ok' || !result.data) {
    const mapped = describeMcpError(result);
    return jsonError(mapped.status, mapped.error, mapped.message);
  }
  return jsonOk(result.data);
}

// Добавить сервер: ядро подключает его без перезапуска, ошибка подключения не роняет ядро.
export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const body = await readJson(request);
  if (!body) return jsonError(400, 'invalid_mcp', 'Неверный формат запроса.');
  const parsed = validateMcpApiBody(body, { requireName: true });
  if (parsed.ok === false) return jsonError(400, 'invalid_mcp', parsed.message);

  let result;
  try {
    result = await createMcpServer(auth.user, parsed.value);
  } catch {
    return jsonError(503, 'identity_unconfigured', IDENTITY_ERROR);
  }
  if (result.state !== 'ok' || !result.data) {
    const mapped = describeMcpError(result);
    return jsonError(mapped.status, mapped.error, mapped.message);
  }
  await recordAudit(auth.user, 'mcp.server.create', { type: 'mcp', id: String(parsed.value.name) }, {
    transport: parsed.value.transport,
    enabled: parsed.value.enabled ?? true,
  });
  return jsonOk(result.data);
}
