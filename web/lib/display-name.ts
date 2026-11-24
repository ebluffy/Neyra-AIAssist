const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MAX_DISPLAY_NAME_LENGTH = 64;

export function sanitizeDisplayName(value: string | null | undefined): string {
  return (value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function cleanDisplayName(value: string | null | undefined): string {
  return sanitizeDisplayName(value).slice(0, MAX_DISPLAY_NAME_LENGTH);
}

export function isEmailLike(value: string | null | undefined): boolean {
  return EMAIL_RE.test((value ?? '').trim());
}

export function emailLocalPart(email: string | null | undefined): string {
  const value = (email ?? '').trim();
  if (!value) return '';
  const at = value.indexOf('@');
  return (at > 0 ? value.slice(0, at) : value).trim();
}

/**
 * Имя для обращения: сохранённое имя, иначе часть email до @.
 * Полный email никогда не становится именем в диалоге.
 */
export function defaultDisplayName(
  email: string | null | undefined,
  name?: string | null,
): string {
  const value = cleanDisplayName(name);
  if (value && value !== 'Пользователь' && !EMAIL_RE.test(value)) return value;
  return emailLocalPart(email) || emailLocalPart(value);
}
