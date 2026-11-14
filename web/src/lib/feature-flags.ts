/**
 * Central Feature Flags Registry for Neyra Web.
 * Enables incremental feature rollout with explicit UI stubs.
 *
 * Priority:
 * 1. URL search parameter: ?ff=<flag1>,<flag2> (use !flag or -flag to disable)
 * 2. localStorage: ff_<flag> ('1'/'true' or '0'/'false')
 * 3. Default from FLAGS
 */

export const FLAGS = {
  authDiscord: true, // вход через Discord
  authInvite: false, // вход по инвайту
  chatAttachments: false, // вложения в чате
  chatVoice: false, // голос
  mcpAdmin: false, // раздел MCP в админке
  providersCatalog: false, // каталог провайдеров
  threadsDb: false, // история из БД
  notes: false, // заметки
  exportData: false, // экспорт данных
} as const;

export type Flag = keyof typeof FLAGS;

export function isEnabled(flag: Flag): boolean {
  if (typeof window !== 'undefined') {
    // 1. Check URL parameters
    try {
      const search = window.location?.search;
      if (search) {
        const params = new URLSearchParams(search);
        const ffParam = params.get('ff');
        if (ffParam) {
          const list = ffParam.split(',').map((s) => s.trim());
          if (list.includes(`!${flag}`) || list.includes(`-${flag}`)) {
            return false;
          }
          if (list.includes(flag)) {
            return true;
          }
        }
        if (params.has(`ff_${flag}`)) {
          const val = params.get(`ff_${flag}`)?.toLowerCase();
          if (val === '1' || val === 'true') return true;
          if (val === '0' || val === 'false') return false;
        }
      }
    } catch {
      // ignore URL parsing issues in non-standard environments
    }

    // 2. Check localStorage
    try {
      const stored = window.localStorage?.getItem(`ff_${flag}`)?.toLowerCase();
      if (stored === '1' || stored === 'true') {
        return true;
      }
      if (stored === '0' || stored === 'false') {
        return false;
      }
    } catch {
      // ignore storage access restrictions
    }
  }

  // 3. Fallback to constant default
  return Boolean(FLAGS[flag]);
}

/**
 * Set a feature flag override in localStorage
 */
export function setFlagOverride(flag: Flag, enabled: boolean | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (enabled === null) {
      window.localStorage?.removeItem(`ff_${flag}`);
    } else {
      window.localStorage?.setItem(`ff_${flag}`, enabled ? '1' : '0');
    }
  } catch {
    // ignore
  }
}
