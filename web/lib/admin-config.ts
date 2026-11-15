// Настройки ядра для админки: чтение снимка, разбор правок и запись.
// Белый список и диапазоны проверяет ядро; сайт отсекает мусор до запроса
// и пишет собственное действие в admin_audit.

import { coreGet, corePut, type CoreResult } from './core-admin';

export interface LaneConfig {
  provider: string;
  model: string;
  resolved_model: string;
  temperature: number | null;
  context_window: number | null;
  max_tokens: number | null;
  enabled: boolean | null;
  thinking: boolean | null;
}

export interface MemoryLimits {
  'memory.stm_max_messages': number;
  'memory.max_records': number;
  'memory.rag_top_k': number;
  'memory.diary_max_entries': number;
  [key: string]: number;
}

export interface ConfigSnapshot {
  version: string;
  uptime_seconds: number;
  lanes: Record<string, LaneConfig>;
  providers: string[];
  memory: {
    limits: MemoryLimits;
    autocompact: { enabled: boolean; mode: string; threshold_messages: number };
  };
  mcp: { enabled: boolean; servers: Array<{ name: string; enabled: boolean }> };
  secrets: Record<string, 'set' | 'missing'>;
  editable: string[];
}

export interface ConfigWriteResult {
  applied: Record<string, unknown>;
  persisted: string[];
  backups: string[];
  requires_restart: boolean;
  restart_fields: string[];
  llm_rebound: boolean;
}

export interface LogTail {
  file: string;
  lines: string[];
  count: number;
  truncated: boolean;
  missing: boolean;
}

export const CONFIG_AUDIT_ACTION = 'config.write';
export const LOG_LINES_DEFAULT = 200;
export const LOG_LINES_MAX = 1000;
export const MAX_UPDATES = 50;
export const MAX_STRING_VALUE = 200;

export type ScalarUpdate = string | number | boolean;

export type ParsedUpdates =
  | { ok: true; updates: Record<string, ScalarUpdate> }
  | { ok: false; message: string };

// Ядро принимает только плоские скалярные поля по белому списку.
export function parseConfigUpdates(body: unknown): ParsedUpdates {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, message: 'Ожидается JSON-объект с полем updates.' };
  }
  const raw = (body as { updates?: unknown }).updates;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: 'Поле updates должно быть объектом.' };
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) return { ok: false, message: 'Нет изменений: передайте хотя бы одно поле.' };
  if (entries.length > MAX_UPDATES) {
    return { ok: false, message: `Слишком много полей за раз: не больше ${MAX_UPDATES}.` };
  }
  const updates: Record<string, ScalarUpdate> = {};
  for (const [key, value] of entries) {
    const path = key.trim();
    if (!path || path.length > 120 || !/^[a-z0-9_.]+$/i.test(path)) {
      return { ok: false, message: `Некорректное имя поля: ${key}.` };
    }
    if (typeof value === 'string') {
      if (value.length > MAX_STRING_VALUE) {
        return { ok: false, message: `${path}: значение слишком длинное.` };
      }
      updates[path] = value;
      continue;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return { ok: false, message: `${path}: ожидается конечное число.` };
      updates[path] = value;
      continue;
    }
    if (typeof value === 'boolean') {
      updates[path] = value;
      continue;
    }
    return { ok: false, message: `${path}: допустимы строка, число или true/false.` };
  }
  return { ok: true, updates };
}

export function clampLogLines(value: unknown): number {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return LOG_LINES_DEFAULT;
  return Math.min(Math.trunc(parsed), LOG_LINES_MAX);
}

export interface AdminCoreOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function readAdminConfig(options: AdminCoreOptions = {}): Promise<CoreResult<ConfigSnapshot>> {
  return coreGet<ConfigSnapshot>('/v1/config', { timeoutMs: 4000, forwardMessage: true, ...options });
}

export function writeAdminConfig(
  updates: Record<string, ScalarUpdate>,
  options: AdminCoreOptions = {},
): Promise<CoreResult<ConfigWriteResult>> {
  return corePut<ConfigWriteResult>('/v1/config', { updates }, { timeoutMs: 10000, forwardMessage: true, ...options });
}

export function readAdminLogTail(
  lines: unknown = LOG_LINES_DEFAULT,
  options: AdminCoreOptions = {},
): Promise<CoreResult<LogTail>> {
  return coreGet<LogTail>(`/v1/logs/tail?lines=${clampLogLines(lines)}`, { timeoutMs: 5000, forwardMessage: true, ...options });
}
