import { requireAdmin } from '../../../../../lib/admin-guard';
import {
  CONFIG_AUDIT_ACTION,
  parseConfigUpdates,
  readAdminConfig,
  writeAdminConfig,
} from '../../../../../lib/admin-config';
import { recordAudit } from '../../../../../lib/admin-audit';
import { jsonError, jsonOk, readJson } from '../../../../../lib/admin-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Ошибка ядра → ошибка сайта: неверные поля остаются 400, недоступность — 502/503.
function coreErrorStatus(status: number | undefined): number {
  if (status === 400 || status === 422) return 400;
  if (status === 401 || status === 403) return 502;
  return 503;
}

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const result = await readAdminConfig();
  if (result.state === 'unsupported') {
    return jsonOk({ supported: false, config: null, message: result.message ?? 'Ядро не поддерживает настройки моделей.' });
  }
  if (result.state !== 'ok') {
    return jsonError(
      coreErrorStatus(result.status),
      result.state === 'unconfigured' ? 'core_unconfigured' : 'core_unavailable',
      result.message ?? 'Ядро не отдало конфиг.',
    );
  }
  return jsonOk({ config: result.data });
}

export async function PUT(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const parsed = parseConfigUpdates(await readJson(request));
  if (!parsed.ok) return jsonError(400, 'bad_request', parsed.message);

  const result = await writeAdminConfig(parsed.updates);
  if (result.state === 'unsupported') {
    return jsonOk({ supported: false, message: result.message ?? 'Ядро не поддерживает настройки моделей.' });
  }
  if (result.state !== 'ok') {
    return jsonError(
      coreErrorStatus(result.status),
      result.state === 'error' ? 'invalid_config' : 'core_unavailable',
      result.message ?? 'Ядро не приняло настройки.',
    );
  }

  const keys = Object.keys(parsed.updates).sort();
  await recordAudit(auth.user, CONFIG_AUDIT_ACTION, { type: 'core', id: 'config' }, {
    keys: keys.join(','),
    count: keys.length,
    requires_restart: Boolean(result.data?.requires_restart),
  });
  return jsonOk(result.data ?? {});
}
