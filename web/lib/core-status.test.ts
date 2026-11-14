import { describe, expect, it } from 'vitest';
import { describeCoreHealth, describeReady, humanizeErrorClass } from './core-status';
import type { CoreResult } from './core-admin';

function ok<T>(data: T, status = 200): CoreResult<T> {
  return { state: 'ok', data, status };
}

describe('describeCoreHealth', () => {
  it('is green only when every signal is green', () => {
    expect(describeCoreHealth(ok({ ok: true, status: 'ok', backend: { ok: true } }))).toEqual({
      tone: 'ok',
      label: 'Ядро в норме',
      reason: null,
    });
  });

  it('shows degraded when only backend/degraded_reason says so', () => {
    const view = describeCoreHealth(ok({
      ok: true,
      status: 'ok',
      backend: {
        ok: false,
        degraded_reason: { error_class: 'OpenAIRateLimitError', at: '2026-11-13T12:00:00+03:00' },
      },
    }));
    expect(view.tone).toBe('warn');
    expect(view.label).toBe('Ядро деградировало');
    expect(view.reason).toContain('лимит провайдера');
    expect(view.reason).toContain('OpenAIRateLimitError');
    expect(view.reason).toContain('МСК');
  });

  it('shows degraded for status=degraded even when ok is missing', () => {
    const view = describeCoreHealth(ok({ status: 'degraded', degraded_reason: { error_class: 'TimeoutError' } }));
    expect(view.tone).toBe('warn');
    expect(view.reason).toContain('таймаут');
  });

  it('separates unconfigured from unavailable', () => {
    expect(describeCoreHealth({ state: 'unconfigured', data: null }).label).toBe('Ядро не подключено');
    expect(describeCoreHealth({ state: 'unavailable', data: null, message: 'Ядро недоступно.' })).toMatchObject({
      tone: 'error',
      label: 'Ядро недоступно',
      reason: 'Ядро недоступно.',
    });
  });
});

describe('describeReady', () => {
  it('renders checks and marks 503 as not ready', () => {
    const view = describeReady(ok({
      checks: [
        { name: 'memory_hub', ok: true, ms: 3 },
        { name: 'llm_provider', ok: false, reason: 'OpenAIRateLimitError' },
      ],
    }, 503));
    expect(view.tone).toBe('error');
    expect(view.label).toBe('Не готово');
    expect(view.checks).toHaveLength(2);
    expect(view.reason).toContain('llm_provider');
    expect(view.reason).toContain('OpenAIRateLimitError');
  });

  it('marks 200 with all checks ok as ready', () => {
    const view = describeReady(ok({ checks: [{ name: 'memory_hub', ok: true }] }, 200));
    expect(view).toMatchObject({ tone: 'ok', label: 'Готово', reason: null });
  });

  it('does not pretend readiness when checks are missing', () => {
    expect(describeReady(ok({}, 200))).toMatchObject({ tone: 'warn', label: 'Нет проверок' });
  });
});

describe('humanizeErrorClass', () => {
  it('maps provider failures to plain Russian', () => {
    expect(humanizeErrorClass('OpenAIRateLimitError')).toContain('лимит');
    expect(humanizeErrorClass('ReadTimeout')).toContain('таймаут');
    expect(humanizeErrorClass('AuthenticationError')).toContain('ключ');
    expect(humanizeErrorClass('WeirdError')).toBe('WeirdError');
    expect(humanizeErrorClass('')).toBe('причина не указана');
  });
});
