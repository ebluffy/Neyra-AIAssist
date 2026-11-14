// MCP-серверы: типы, проверки и серверный транспорт к ядру.
// Значения env ядро не отдаёт — только имена и флаг «задан».

import { coreDelete, coreGet, corePost, corePut, type CoreRequest, type CoreResult } from './core-admin';
import type { AdminUser } from './admin-guard';
import { createIdentityToken } from './identity';

export const MCP_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
export const MCP_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const MCP_TRANSPORTS = ['stdio', 'sse'] as const;
export const MAX_MCP_ARGS = 50;
export const MAX_MCP_ARG_LENGTH = 500;
export const MAX_MCP_ENV = 50;

export type McpTransport = (typeof MCP_TRANSPORTS)[number];
export type McpStatus = 'connected' | 'error' | 'disabled' | 'disconnected';

export interface McpEnvVar {
  name: string;
  set: boolean;
}

export interface McpServer {
  name: string;
  enabled: boolean;
  transport: McpTransport;
  command: string | null;
  args: string[];
  url: string | null;
  cwd: string | null;
  env: McpEnvVar[];
  status: McpStatus;
  tools: number;
  last_error: string | null;
  checked_at: string | null;
}

export interface McpPayload {
  enabled: boolean;
  servers: McpServer[];
}

export interface McpWriteBody {
  name?: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  cwd?: string;
  env?: Record<string, string>;
  enabled?: boolean;
}

export interface McpValidationError {
  ok: false;
  field: string;
  message: string;
}

export interface McpValidationOk {
  ok: true;
  value: McpWriteBody;
}

const FIELD_LABELS: Record<string, string> = {
  name: 'Имя',
  transport: 'Транспорт',
  command: 'Команда',
  args: 'Аргументы',
  url: 'URL',
  cwd: 'Рабочая папка',
  env: 'Переменные окружения',
  enabled: 'Включён',
};

function fail(field: string, message: string): McpValidationError {
  return { ok: false, field, message };
}

function normalizeArgs(raw: unknown): { ok: true; args: string[] } | McpValidationError {
  if (raw == null) return { ok: true, args: [] };
  if (!Array.isArray(raw)) return fail('args', 'Аргументы: ожидается список строк.');
  if (raw.length > MAX_MCP_ARGS) return fail('args', `Аргументы: не больше ${MAX_MCP_ARGS}.`);
  const args: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string') return fail('args', 'Аргументы: каждый аргумент — строка.');
    if (value.length > MAX_MCP_ARG_LENGTH) {
      return fail('args', `Аргументы: каждый не длиннее ${MAX_MCP_ARG_LENGTH} символов.`);
    }
    args.push(value);
  }
  return { ok: true, args };
}

function normalizeEnv(raw: unknown): { ok: true; env?: Record<string, string> } | McpValidationError {
  if (raw == null) return { ok: true };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('env', 'Переменные окружения: ожидается объект имя → значение.');
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_MCP_ENV) {
    return fail('env', `Переменные окружения: не больше ${MAX_MCP_ENV}.`);
  }
  const env: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (!MCP_ENV_NAME_RE.test(name)) {
      return fail('env', `Переменные окружения: некорректное имя «${name}».`);
    }
    if (typeof value !== 'string') {
      return fail('env', `Переменная ${name}: значение должно быть строкой.`);
    }
    if (value.length > 4000) {
      return fail('env', `Переменная ${name}: значение длиннее 4000 символов.`);
    }
    env[name] = value;
  }
  return { ok: true, env };
}

/**
 * Проверка тела POST/PUT для BFF. Не доверяет браузеру: те же границы, что у ядра.
 * Для create имя обязательно; для update имя не меняется.
 */
export function validateMcpApiBody(raw: unknown, options: { requireName: boolean }): McpValidationOk | McpValidationError {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('body', 'Неверный формат запроса.');
  }
  const input = raw as Record<string, unknown>;

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (options.requireName) {
    if (!name) return fail('name', 'Имя: обязательно.');
    if (!MCP_NAME_RE.test(name)) {
      return fail('name', 'Имя: 1–64 символа, латиница, цифры, точка, дефис или подчёркивание.');
    }
  } else if (name && !MCP_NAME_RE.test(name)) {
    return fail('name', 'Имя: 1–64 символа, латиница, цифры, точка, дефис или подчёркивание.');
  }

  const transport = typeof input.transport === 'string' ? input.transport.trim().toLowerCase() : '';
  if (transport !== 'stdio' && transport !== 'sse') {
    return fail('transport', 'Транспорт: выберите stdio или SSE.');
  }

  const enabled = typeof input.enabled === 'boolean' ? input.enabled : true;
  const cwd = typeof input.cwd === 'string' ? input.cwd.trim() : '';
  if (cwd.length > 300) return fail('cwd', 'Рабочая папка: не длиннее 300 символов.');

  const envResult = normalizeEnv(input.env);
  if (envResult.ok === false) return envResult;

  const base: McpWriteBody = {
    transport,
    enabled,
    cwd,
    ...(envResult.env ? { env: envResult.env } : {}),
  };

  if (transport === 'stdio') {
    const command = typeof input.command === 'string' ? input.command.trim() : '';
    if (!command) return fail('command', 'Команда: обязательна для stdio.');
    if (command.length > 500) return fail('command', 'Команда: не длиннее 500 символов.');
    const argsResult = normalizeArgs(input.args);
    if (argsResult.ok === false) return argsResult;
    return {
      ok: true,
      value: { ...base, ...(options.requireName ? { name } : {}), command, args: argsResult.args },
    };
  }

  const url = typeof input.url === 'string' ? input.url.trim() : '';
  if (!url) return fail('url', 'URL: обязателен для SSE.');
  if (url.length > 2000) return fail('url', 'URL: не длиннее 2000 символов.');
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      return fail('url', 'URL: нужен HTTP(S)-адрес без логина и пароля в строке.');
    }
  } catch {
    return fail('url', 'URL: нужен HTTP(S)-адрес без логина и пароля в строке.');
  }
  return { ok: true, value: { ...base, ...(options.requireName ? { name } : {}), url } };
}

export function localizeMcpCoreError(message: string): string {
  const match = /^([A-Za-z_]+(?:\.[A-Za-z0-9_]+)?)\s*:\s*(.+)$/.exec(message.trim());
  if (!match) return message;
  const field = match[1];
  if (field.startsWith('env.')) {
    return `Переменная «${field.slice(4)}»: ${match[2]}`;
  }
  const label = FIELD_LABELS[field];
  return label ? `Поле «${label}»: ${match[2]}` : message;
}

export interface McpActionError {
  status: number;
  error: string;
  message: string;
}

export function describeMcpError(result: CoreResult<unknown>): McpActionError {
  if (result.state === 'unconfigured') {
    return {
      status: 503,
      error: 'core_unconfigured',
      message: result.message ?? 'Ядро не подключено: проверьте NEYRA_API_URL и NEYRA_SERVICE_KEY.',
    };
  }
  if (result.state === 'unauthorized') {
    return {
      status: 502,
      error: 'core_unauthorized',
      message: 'Ядро отклонило ключ сайта. Проверьте NEYRA_SERVICE_KEY.',
    };
  }
  if (result.state === 'unavailable') {
    return {
      status: 502,
      error: 'core_unavailable',
      message: result.message ?? 'Ядро недоступно. Настройки MCP не изменены.',
    };
  }
  if (result.status === 409) {
    return { status: 409, error: 'conflict', message: 'Сервер с таким именем уже есть.' };
  }
  if (result.status === 404) {
    return { status: 404, error: 'not_found', message: 'Сервер не найден. Обновите список.' };
  }
  if (result.status === 400) {
    return {
      status: 400,
      error: 'invalid_mcp',
      message: localizeMcpCoreError(result.message ?? 'Ядро не приняло настройки MCP.'),
    };
  }
  return {
    status: 502,
    error: 'core_error',
    message: result.message ?? 'Ядро вернуло ошибку. Настройки MCP могли не примениться.',
  };
}

/** Identity-заголовок для админского вызова ядра; без env бросает понятную ошибку. */
export async function mcpIdentityHeaders(user: AdminUser): Promise<Record<string, string>> {
  const token = await createIdentityToken(user, undefined, { task: 'admin-mcp' });
  return { 'X-Neyra-Identity': token };
}

async function optionsFor(user: AdminUser, timeoutMs: number): Promise<CoreRequest> {
  return { headers: await mcpIdentityHeaders(user), timeoutMs };
}

export async function readMcpServers(user: AdminUser): Promise<CoreResult<McpPayload>> {
  return coreGet<McpPayload>('/v1/mcp/servers', await optionsFor(user, 8000));
}

export async function createMcpServer(user: AdminUser, body: McpWriteBody): Promise<CoreResult<McpPayload>> {
  return corePost<McpPayload>('/v1/mcp/servers', body, await optionsFor(user, 20000));
}

export async function updateMcpServer(
  user: AdminUser,
  name: string,
  body: McpWriteBody,
): Promise<CoreResult<McpPayload>> {
  return corePut<McpPayload>(
    `/v1/mcp/servers/${encodeURIComponent(name)}`,
    body,
    await optionsFor(user, 20000),
  );
}

export async function deleteMcpServer(user: AdminUser, name: string): Promise<CoreResult<McpPayload>> {
  return coreDelete<McpPayload>(
    `/v1/mcp/servers/${encodeURIComponent(name)}`,
    await optionsFor(user, 20000),
  );
}

export async function restartMcpServer(user: AdminUser, name: string): Promise<CoreResult<McpPayload>> {
  return corePost<McpPayload>(
    `/v1/mcp/servers/${encodeURIComponent(name)}/restart`,
    {},
    await optionsFor(user, 20000),
  );
}

export async function reloadMcpServers(user: AdminUser): Promise<CoreResult<McpPayload>> {
  return corePost<McpPayload>('/v1/mcp/reload', {}, await optionsFor(user, 20000));
}
