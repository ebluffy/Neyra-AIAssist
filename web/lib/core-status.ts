// Честное состояние ядра для обзора админки: /v1/health может отдавать
// status=degraded и backend.ok=false, пока верхние поля ещё выглядят зелёными.
// Логика чистая, чтобы проверяться без сети.

import type { CoreResult } from './core-admin';

export interface DegradedReason {
  error_class?: string;
  at?: string;
  [key: string]: unknown;
}

export interface HealthReport {
  ok?: boolean;
  status?: string;
  backend?: { ok?: boolean; degraded_reason?: DegradedReason | null; provider?: string };
  degraded_reason?: DegradedReason | null;
  version?: string;
  api_version?: string;
  uptime_seconds?: number;
  [key: string]: unknown;
}

export interface ReadyCheck {
  name?: string;
  ok?: boolean;
  reason?: string;
  ms?: number;
}

export interface ReadyReport {
  checks?: ReadyCheck[];
}

export type CoreTone = 'ok' | 'warn' | 'error' | 'muted';

export interface CoreStatusView {
  tone: CoreTone;
  label: string;
  reason: string | null;
}

const momentFormat = new Intl.DateTimeFormat('ru-RU', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'Europe/Moscow',
});

export function humanizeErrorClass(value: string): string {
  const text = value.trim();
  if (!text) return 'причина не указана';
  if (/rate.?limit|429|too.?many/i.test(text)) return 'лимит провайдера (429)';
  if (/timeout|timed.?out/i.test(text)) return 'таймаут провайдера';
  if (/auth|unauthor|forbidden|401|403/i.test(text)) return 'провайдер отклонил ключ';
  if (/connect|network|dns|unavailable/i.test(text)) return 'нет связи с провайдером';
  return text;
}

export function describeDegradedReason(reason: unknown, backendFailed = false): string {
  if (typeof reason === 'string' && reason.trim()) {
    return `Последний отказ: ${humanizeErrorClass(reason)}.`;
  }
  const obj = reason && typeof reason === 'object' ? (reason as DegradedReason) : null;
  if (!obj) {
    return backendFailed ? 'Проверка бэкенда не прошла, причина не указана.' : 'Ядро сообщило о деградации без причины.';
  }
  const rawClass = typeof obj.error_class === 'string' ? obj.error_class : '';
  const human = humanizeErrorClass(rawClass);
  const at = typeof obj.at === 'string' ? obj.at : '';
  let when = '';
  if (at) {
    const date = new Date(at);
    when = Number.isNaN(date.getTime()) ? `, ${at}` : `, ${momentFormat.format(date)} МСК`;
  }
  const code = rawClass && rawClass !== human ? ` (${rawClass})` : '';
  return `Последний отказ: ${human}${code}${when}.`;
}

export function describeCoreHealth(result: CoreResult<HealthReport>): CoreStatusView {
  if (result.state === 'unconfigured') {
    return { tone: 'muted', label: 'Ядро не подключено', reason: result.message ?? null };
  }
  if (result.state !== 'ok') {
    return { tone: 'error', label: 'Ядро недоступно', reason: result.message ?? null };
  }
  const data = result.data ?? {};
  const backend = data.backend ?? {};
  const reason = data.degraded_reason ?? backend.degraded_reason ?? null;
  const backendFailed = backend.ok === false;
  const degraded = data.ok === false || data.status === 'degraded' || backendFailed || Boolean(reason);
  if (!degraded) return { tone: 'ok', label: 'Ядро в норме', reason: null };
  return {
    tone: 'warn',
    label: 'Ядро деградировало',
    reason: describeDegradedReason(reason, backendFailed),
  };
}

export interface ReadyView {
  tone: CoreTone;
  label: string;
  checks: ReadyCheck[];
  reason: string | null;
}

export function describeReady(result: CoreResult<ReadyReport>): ReadyView {
  if (result.state === 'unconfigured') {
    return { tone: 'muted', label: 'Ядро не подключено', checks: [], reason: result.message ?? null };
  }
  if (result.state !== 'ok') {
    return { tone: 'error', label: 'Ядро недоступно', checks: [], reason: result.message ?? null };
  }
  const checks = Array.isArray(result.data?.checks) ? result.data.checks : [];
  if (checks.length === 0) {
    return { tone: 'warn', label: 'Нет проверок', checks, reason: 'Ядро не вернуло список проверок готовности.' };
  }
  const failed = checks.filter(check => check.ok === false);
  const ready = result.status === 200 && failed.length === 0;
  return {
    tone: ready ? 'ok' : 'error',
    label: ready ? 'Готово' : 'Не готово',
    checks,
    reason: ready ? null : failed.map(check => `${check.name ?? 'проверка'}: ${check.reason ?? 'сбой'}`).join('; '),
  };
}
