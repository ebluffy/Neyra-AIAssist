import { getAuth } from '../../../../lib/auth';
import {
  getUserOnboardingCompleted,
  setUserOnboardingCompleted,
  setUserName,
} from '../../../../lib/admin-users';
import { jsonError, jsonOk, readJson } from '../../../../lib/admin-http';
import { cleanDisplayName, defaultDisplayName, isEmailLike, sanitizeDisplayName } from '../../../../lib/display-name';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_NAME_LENGTH = 64;

// AR-80: признак онбординга хранится на сервере, а не в localStorage браузера.
// Иначе на новом устройстве уже знакомый пользователь снова попадает в /onboarding.
export async function GET(request: Request) {
  let session;
  try {
    session = await getAuth().api.getSession({ headers: request.headers });
  } catch {
    return jsonError(503, 'auth_unavailable', 'Сервис входа временно недоступен.');
  }
  if (!session?.user) {
    return jsonError(401, 'unauthorized', 'Требуется авторизация.');
  }

  const state = await getUserOnboardingCompleted(session.user.id);
  if (!state.ok) {
    if (state.error === 'not-found') {
      return jsonError(404, 'not_found', 'Пользователь не найден.');
    }
    return jsonError(503, 'db_error', 'Профиль временно недоступен.');
  }
  return jsonOk({
    name: defaultDisplayName(session.user.email, session.user.name),
    onboarding_completed: state.value,
  });
}

// AR-74: своё имя меняет сам пользователь. Админская ручка
// /api/admin/users/{id} требует роль admin, поэтому для обычного пользователя
// нужна отдельная дверь: только name и onboarding_completed, только для своей сессии.
export async function PATCH(request: Request) {
  let session;
  try {
    session = await getAuth().api.getSession({ headers: request.headers });
  } catch {
    return jsonError(503, 'auth_unavailable', 'Сервис входа временно недоступен.');
  }
  if (!session?.user) {
    return jsonError(401, 'unauthorized', 'Требуется авторизация.');
  }

  const body = await readJson(request);
  if (!body) {
    return jsonError(400, 'bad_request', 'Ожидается JSON-объект.');
  }
  const extra = Object.keys(body).filter((key) => key !== 'name' && key !== 'onboarding_completed');
  if (extra.length > 0) {
    return jsonError(400, 'bad_request', 'Менять можно только name и onboarding_completed.');
  }

  const hasName = Object.prototype.hasOwnProperty.call(body, 'name');
  const hasOnboarding = Object.prototype.hasOwnProperty.call(body, 'onboarding_completed');
  if (!hasName && !hasOnboarding) {
    return jsonError(400, 'bad_request', 'Нужно передать name или onboarding_completed.');
  }
  if (hasOnboarding && typeof body.onboarding_completed !== 'boolean') {
    return jsonError(400, 'bad_request', 'Поле onboarding_completed должно быть boolean.');
  }
  if (body.onboarding_completed === false) {
    return jsonError(400, 'bad_request', 'Сбросить завершённый онбординг нельзя.');
  }

  let name: string | undefined;
  if (hasName) {
    if (typeof body.name !== 'string') {
      return jsonError(400, 'bad_request', 'Поле name должно быть строкой.');
    }
    name = sanitizeDisplayName(body.name);
    if (!name) {
      return jsonError(400, 'bad_request', 'Имя не может быть пустым.');
    }
    if (isEmailLike(name)) {
      return jsonError(400, 'bad_request', 'Имя не может быть email-адресом.');
    }
    if (name.length > MAX_NAME_LENGTH) {
      return jsonError(400, 'bad_request', `Имя длиннее ${MAX_NAME_LENGTH} символов.`);
    }
    name = cleanDisplayName(name);
    const result = await setUserName(session.user.id, name);
    if (!result.ok) {
      return jsonError(
        result.error === 'not-found' ? 404 : 500,
        result.error === 'not-found' ? 'not_found' : 'db_error',
        'Не удалось обновить имя. Попробуйте ещё раз.',
      );
    }
  }

  if (hasOnboarding) {
    const result = await setUserOnboardingCompleted(session.user.id, true);
    if (!result.ok) {
      return jsonError(
        result.error === 'not-found' ? 404 : 500,
        result.error === 'not-found' ? 'not_found' : 'db_error',
        'Не удалось завершить знакомство. Попробуйте ещё раз.',
      );
    }
  }

  return jsonOk({
    ...(name ? { name } : {}),
    ...(hasOnboarding ? { onboarding_completed: true } : {}),
  });
}
