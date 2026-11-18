import { requireAdmin } from '../../../../../lib/admin-guard';
import {
  REGISTRATION_MODES,
  SETTINGS_AUDIT_ACTION,
  getRegistrationMode,
  isRegistrationMode,
  setRegistrationMode,
} from '../../../../../lib/site-settings';
import { recordAudit } from '../../../../../lib/admin-audit';
import { jsonError, jsonOk, readJson } from '../../../../../lib/admin-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const mode = await getRegistrationMode();
  return jsonOk({ registration_mode: mode });
}

// Режим регистрации: invite | open | closed. Всё остальное отклоняется до записи.
export async function PUT(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;
  const body = await readJson(request);
  const raw = body?.registration_mode;
  if (!isRegistrationMode(raw)) {
    return jsonError(
      400,
      'bad_request',
      `registration_mode: ожидается одно из ${REGISTRATION_MODES.join(', ')}.`,
    );
  }

  const { previous, current } = await setRegistrationMode(raw);
  if (previous !== current) {
    await recordAudit(auth.user, SETTINGS_AUDIT_ACTION, { type: 'setting', id: 'registration_mode' }, {
      from: previous,
      to: current,
    });
  }
  return jsonOk({ registration_mode: current });
}
