// Режим регистрации сайта: хранится в site_setting, читается на сервере.
// При недоступной БД не роняем вход/регистрацию: откатываемся к env
// INVITE_REQUIRED, а без него — к самому безопасному режиму 'invite'.

import { eq } from 'drizzle-orm';
import { getDatabase } from './db';
import { siteSetting } from '../db/schema';

import {
  DEFAULT_REGISTRATION_MODE,
  REGISTRATION_MODES,
  fallbackRegistrationMode,
  isRegistrationMode,
  parseRegistrationMode,
  type RegistrationMode,
} from './registration-mode';

export { DEFAULT_REGISTRATION_MODE, REGISTRATION_MODES, fallbackRegistrationMode, isRegistrationMode, parseRegistrationMode };
export type { RegistrationMode };

export const REGISTRATION_MODE_KEY = 'registration_mode';
// Действие в admin_audit при смене режима.
export const SETTINGS_AUDIT_ACTION = 'settings.write';
export const REGISTRATION_MODE_CACHE_MS = 5_000;

type Reader = () => Promise<string | null>;
type Writer = (value: string) => Promise<void>;

async function readFromDatabase(): Promise<string | null> {
  const { db } = getDatabase();
  const rows = await db.select({ value: siteSetting.value })
    .from(siteSetting)
    .where(eq(siteSetting.key, REGISTRATION_MODE_KEY))
    .limit(1);
  return rows[0]?.value ?? null;
}

async function writeToDatabase(value: string): Promise<void> {
  const { db } = getDatabase();
  await db.insert(siteSetting)
    .values({ key: REGISTRATION_MODE_KEY, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: siteSetting.key,
      set: { value, updatedAt: new Date() },
    });
}

interface CacheEntry {
  value: RegistrationMode;
  at: number;
}

let cache: CacheEntry | null = null;

export function resetRegistrationModeCache(): void {
  cache = null;
}

export interface ReadOptions {
  env?: Record<string, string | undefined>;
  reader?: Reader;
  now?: number;
  cacheMs?: number;
}

// Короткий кэш (≤5 с): админ-изменение подхватывается почти сразу,
// а хук регистрации не бьёт в БД на каждый запрос.
export async function getRegistrationMode(options: ReadOptions = {}): Promise<RegistrationMode> {
  const now = options.now ?? Date.now();
  const cacheMs = options.cacheMs ?? REGISTRATION_MODE_CACHE_MS;
  if (cache && now - cache.at < cacheMs) return cache.value;

  let value: RegistrationMode;
  try {
    const stored = await (options.reader ?? readFromDatabase)();
    value = stored === null ? fallbackRegistrationMode(options.env) : parseRegistrationMode(stored);
  } catch {
    // База недоступна: вход не ломаем, регистрацию не открываем молча.
    value = fallbackRegistrationMode(options.env);
  }
  cache = { value, at: now };
  return value;
}

export interface WriteOptions {
  writer?: Writer;
  // Для тестов и CLI: откуда читать «предыдущее» значение.
  reader?: Reader;
}

// Возвращает предыдущий режим — его пишет вызывающий в admin_audit.
export async function setRegistrationMode(
  mode: RegistrationMode,
  options: WriteOptions = {},
): Promise<{ previous: RegistrationMode; current: RegistrationMode }> {
  if (!isRegistrationMode(mode)) throw new Error('invalid registration mode');
  const previous = await getRegistrationMode({ cacheMs: 0, reader: options.reader });
  await (options.writer ?? writeToDatabase)(mode);
  cache = { value: mode, at: Date.now() };
  return { previous, current: mode };
}
