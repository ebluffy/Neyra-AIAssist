import { getAuth, takeResetLink } from './auth';
import { readAuthEnv } from './env';

// Сброс пароля админом: письма сайт не отправляет. Админ получает одноразовую
// ссылку и передаёт её пользователю. В базе лежит только хэш токена (таблица verification).
export type ResetLinkResult =
  | { ok: true; url: string }
  | { ok: false; reason: 'not-found' | 'unavailable' };

export async function createResetLink(email: string): Promise<ResetLinkResult> {
  let baseURL: string;
  try {
    baseURL = readAuthEnv().baseURL;
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  try {
    await getAuth().api.requestPasswordReset({
      body: { email: email.trim().toLowerCase(), redirectTo: `${baseURL}/reset-password` },
    });
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  const url = takeResetLink(email);
  return url ? { ok: true, url } : { ok: false, reason: 'not-found' };
}
