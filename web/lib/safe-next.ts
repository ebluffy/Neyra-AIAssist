const BASE = 'http://neyra.local';

/**
 * Возвращает только относительный путь на этом же origin. Нужен для `next`
 * после логина и callbackURL OAuth: браузер молча выкидывает табы/переводы
 * строк, поэтому проверки строки недостаточно — разбираем URL.
 */
export function sanitizeNextPath(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  if (/[\x00-\x1f]/.test(value)) return undefined;
  try {
    const url = new URL(value, BASE);
    if (url.origin !== BASE) return undefined;
    if (!url.pathname.startsWith('/')) return undefined;
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(url.pathname);
    } catch {
      return undefined;
    }
    if (decodedPath.startsWith('//') || /[\x00-\x1f]/.test(decodedPath)) return undefined;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return undefined;
  }
}
