import { z } from 'zod';
export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 128;
export const credentialsSchema = z.object({
  email: z.string().trim().email('Введите корректный email.'),
  password: z.string().min(MIN_PASSWORD_LENGTH, 'Пароль должен содержать не менее 10 символов.').max(MAX_PASSWORD_LENGTH, 'Пароль должен содержать не более 128 символов.'),
});
// Never accept a privileged role from registration input.
export const roleField = { type: ['admin', 'user'] as ('admin' | 'user')[], required: false, defaultValue: 'user', input: false } as const;
export function authErrorText(code?: string): string {
  switch (code) {
    case 'INVALID_EMAIL_OR_PASSWORD': return 'Неверный email или пароль.';
    case 'USER_ALREADY_EXISTS': case 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL': return 'Аккаунт с таким email уже существует.';
    case 'INVALID_EMAIL': return 'Введите корректный email.';
    case 'PASSWORD_TOO_SHORT': return 'Пароль должен содержать не менее 10 символов.';
    case 'PASSWORD_TOO_LONG': return 'Пароль должен содержать не более 128 символов.';
    case 'TOO_MANY_REQUESTS': return 'Слишком много попыток. Попробуйте позже.';
    default: return 'Не удалось выполнить запрос. Попробуйте позже.';
  }
}
