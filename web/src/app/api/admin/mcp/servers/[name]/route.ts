import { requireAdmin } from '../../../../../../../lib/admin-guard';
import {
  MCP_NAME_RE,
  deleteMcpServer,
  describeMcpError,
  updateMcpServer,
  validateMcpApiBody,
} from '../../../../../../../lib/admin-mcp';
import { recordAudit } from '../../../../../../../lib/admin-audit';
import { jsonError, jsonOk, readJson } from '../../../../../../../lib/admin-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const IDENTITY_ERROR = 'Не настроен identity-токен сайта: проверьте NEYRA_IDENTITY_JWT_SECRET и NEYRA_IDENTITY_JWT_ISSUER.';

// Изменить сервер. Имя не меняется; env передаётся только при полной замене.
export async function PUT(request: Request, context: { params: Promise<{ name: string }> }) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const { name } = await context.params;
  if (!MCP_NAME_RE.test(name)) {
    return jsonError(400, 'invalid_mcp', 'Поле «Имя»: 1–64 символа, латиница, цифры, точка, дефис или подчёркивание.');
  }
  const body = await readJson(request);
  if (!body) return jsonError(400, 'invalid_mcp', 'Неверный формат запроса.');
  const parsed = validateMcpApiBody(body, { requireName: false });
  if (parsed.ok === false) return jsonError(400, 'invalid_mcp', parsed.message);

  let result;
  try {
    result = await updateMcpServer(auth.user, name, parsed.value);
  } catch {
    return jsonError(503, 'identity_unconfigured', IDENTITY_ERROR);
  }
  if (result.state !== 'ok' || !result.data) {
    const mapped = describeMcpError(result);
    return jsonError(mapped.status, mapped.error, mapped.message);
  }
  await recordAudit(auth.user, 'mcp.server.update', { type: 'mcp', id: name }, {
    transport: parsed.value.transport,
    enabled: parsed.value.enabled ?? true,
    env_replaced: parsed.value.env !== undefined,
  });
  return jsonOk(result.data);
}

// Удалить сервер вместе с его env. Подтверждение — в интерфейсе.
export async function DELETE(request: Request, context: { params: Promise<{ name: string }> }) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const { name } = await context.params;
  if (!MCP_NAME_RE.test(name)) {
    return jsonError(400, 'invalid_mcp', 'Некорректное имя сервера.');
  }

  let result;
  try {
    result = await deleteMcpServer(auth.user, name);
  } catch {
    return jsonError(503, 'identity_unconfigured', IDENTITY_ERROR);
  }
  if (result.state !== 'ok' || !result.data) {
    const mapped = describeMcpError(result);
    return jsonError(mapped.status, mapped.error, mapped.message);
  }
  await recordAudit(auth.user, 'mcp.server.delete', { type: 'mcp', id: name }, {});
  return jsonOk(result.data);
}
