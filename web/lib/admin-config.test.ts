import { describe, expect, it } from 'vitest';
import {
  clampLogLines,
  parseConfigUpdates,
  readAdminLogTail,
  writeAdminConfig,
} from './admin-config';

const env = { NEYRA_API_URL: 'http://127.0.0.1:8787', NEYRA_SERVICE_KEY: 'test-key' };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('parseConfigUpdates', () => {
  it('accepts flat scalar updates and trims keys', () => {
    const parsed = parseConfigUpdates({
      updates: { ' llm.talk_model.model ': 'new-model', 'llm.talk_model.temperature': 0.5, 'memory.session_archive.enabled': true },
    });
    expect(parsed).toEqual({
      ok: true,
      updates: {
        'llm.talk_model.model': 'new-model',
        'llm.talk_model.temperature': 0.5,
        'memory.session_archive.enabled': true,
      },
    });
  });

  it('rejects empty, non-object and oversized payloads', () => {
    expect(parseConfigUpdates(null).ok).toBe(false);
    expect(parseConfigUpdates({ updates: [] }).ok).toBe(false);
    expect(parseConfigUpdates({ updates: {} }).ok).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`llm.talk_model.f${i}`, 1]));
    expect(parseConfigUpdates({ updates: many }).ok).toBe(false);
  });

  it('rejects nested values, bad keys and non-finite numbers', () => {
    expect(parseConfigUpdates({ updates: { 'llm.talk_model': { model: 'x' } } }).ok).toBe(false);
    expect(parseConfigUpdates({ updates: { 'llm.talk model': 'x' } }).ok).toBe(false);
    expect(parseConfigUpdates({ updates: { 'llm.talk_model.temperature': Number.POSITIVE_INFINITY } }).ok).toBe(false);
    expect(parseConfigUpdates({ updates: { 'llm.talk_model.model': 'x'.repeat(201) } }).ok).toBe(false);
  });
});

describe('clampLogLines', () => {
  it('defaults and clamps', () => {
    expect(clampLogLines(undefined)).toBe(200);
    expect(clampLogLines('50')).toBe(50);
    expect(clampLogLines(0)).toBe(200);
    expect(clampLogLines(-5)).toBe(200);
    expect(clampLogLines(5000)).toBe(1000);
    expect(clampLogLines('abc')).toBe(200);
  });
});

describe('core calls', () => {
  it('writes config with PUT and unwraps the result', async () => {
    let seen: { url?: string; method?: string; body?: string; auth?: string } = {};
    const result = await writeAdminConfig({ 'llm.talk_model.model': 'm1' }, {
      env,
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        seen = {
          url: String(url),
          method: init?.method,
          body: String(init?.body ?? ''),
          auth: new Headers(init?.headers).get('authorization') ?? undefined,
        };
        return json({ ok: true, data: { applied: { 'llm.talk_model.model': 'm1' }, requires_restart: false } });
      }) as typeof fetch,
    });
    expect(seen.url).toBe('http://127.0.0.1:8787/v1/config');
    expect(seen.method).toBe('PUT');
    expect(JSON.parse(String(seen.body))).toEqual({ updates: { 'llm.talk_model.model': 'm1' } });
    expect(seen.auth).toBe('Bearer test-key');
    expect(result.state).toBe('ok');
    expect(result.data?.requires_restart).toBe(false);
  });

  it('keeps the core status for validation errors', async () => {
    const result = await writeAdminConfig({ 'api.token': 'x' }, {
      env,
      fetchImpl: (async () => json({ ok: false, error: { message: 'Поле не разрешено' } }, 400)) as typeof fetch,
    });
    expect(result.state).toBe('error');
    expect(result.status).toBe(400);
    expect(result.message).toBe('Поле не разрешено');
  });

  it('builds the log tail URL with clamped lines', async () => {
    let url = '';
    await readAdminLogTail('9999', {
      env,
      fetchImpl: (async (target: string | URL | Request) => {
        url = String(target);
        return json({ ok: true, data: { file: 'system.log', lines: [], count: 0, truncated: false, missing: false } });
      }) as typeof fetch,
    });
    expect(url).toBe('http://127.0.0.1:8787/v1/logs/tail?lines=1000');
  });

  it('reports an unconfigured core without a request', async () => {
    let called = false;
    const result = await readAdminLogTail(200, {
      env: {},
      fetchImpl: (async () => { called = true; return json({}); }) as typeof fetch,
    });
    expect(result.state).toBe('unconfigured');
    expect(called).toBe(false);
  });
});
