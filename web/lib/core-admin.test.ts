import { describe, expect, it } from 'vitest';
import { coreGet, coreGetReady, corePost, readCoreEnv } from './core-admin';

const env = { NEYRA_API_URL: 'http://127.0.0.1:8787', NEYRA_SERVICE_KEY: 'test-key' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('readCoreEnv', () => {
  it('requires both url and key', () => {
    expect(readCoreEnv({})).toBeNull();
    expect(readCoreEnv({ NEYRA_API_URL: 'http://127.0.0.1:8787' })).toBeNull();
    expect(readCoreEnv({ NEYRA_SERVICE_KEY: 'k' })).toBeNull();
  });

  it('rejects non-http urls and urls with credentials', () => {
    expect(readCoreEnv({ NEYRA_API_URL: 'ftp://core', NEYRA_SERVICE_KEY: 'k' })).toBeNull();
    expect(readCoreEnv({ NEYRA_API_URL: 'http://user:pass@core', NEYRA_SERVICE_KEY: 'k' })).toBeNull();
    expect(readCoreEnv({ NEYRA_API_URL: 'http://core:8787/', NEYRA_SERVICE_KEY: 'k' })).toEqual({
      url: 'http://core:8787',
      token: 'k',
    });
  });
});

describe('coreGet', () => {
  it('does not call the network when the core is not configured', async () => {
    let called = false;
    const result = await coreGet('/v1/health', {
      env: {},
      fetchImpl: (async () => { called = true; return jsonResponse({}); }) as typeof fetch,
    });
    expect(result.state).toBe('unconfigured');
    expect(called).toBe(false);
  });

  it('sends the service key as a bearer token and unwraps data', async () => {
    let seen: { url?: string; auth?: string } = {};
    const result = await coreGet<{ ok: boolean }>('/v1/meta', {
      env,
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        seen = {
          url: String(url),
          auth: new Headers(init?.headers).get('authorization') ?? undefined,
        };
        return jsonResponse({ ok: true, data: { ok: true } });
      }) as typeof fetch,
    });
    expect(result).toEqual({ state: 'ok', data: { ok: true }, status: 200 });
    expect(seen.url).toBe('http://127.0.0.1:8787/v1/meta');
    expect(seen.auth).toBe('Bearer test-key');
  });

  it('keeps the HTTP status on success so readiness can tell 200 from 503', async () => {
    const ready200 = await coreGetReady('/v1/health/ready', {
      env,
      fetchImpl: (async () => jsonResponse({ ok: true, data: { checks: [] } })) as typeof fetch,
    });
    expect(ready200).toMatchObject({ state: 'ok', status: 200 });

    const ready503 = await coreGetReady('/v1/health/ready', {
      env,
      fetchImpl: (async () => jsonResponse({ ok: false, data: { checks: [] } }, 503)) as typeof fetch,
    });
    expect(ready503).toMatchObject({ state: 'ok', status: 503 });
  });

  it('reports rejected keys separately from outages', async () => {
    const unauthorized = await coreGet('/v1/meta', { env, fetchImpl: (async () => jsonResponse({}, 403)) as typeof fetch });
    expect(unauthorized.state).toBe('unauthorized');

    const unavailable = await coreGet('/v1/meta', {
      env,
      fetchImpl: (async () => { throw Object.assign(new Error('boom'), { name: 'TimeoutError' }); }) as typeof fetch,
    });
    expect(unavailable.state).toBe('unavailable');
    expect(unavailable.message).toBe('Ядро не ответило вовремя.');
  });

  it('surfaces the core error message without leaking the raw body', async () => {
    const result = await coreGet('/v1/memory/people', {
      env,
      fetchImpl: (async () => jsonResponse({ ok: false, error: { message: 'Memory Hub is not initialized' } }, 503)) as typeof fetch,
    });
    expect(result.state).toBe('error');
    expect(result.message).toBe('Memory Hub is not initialized');
  });

  it('treats ok:false with 200 as an error', async () => {
    const result = await coreGet('/v1/x', { env, fetchImpl: (async () => jsonResponse({ ok: false })) as typeof fetch });
    expect(result.state).toBe('error');
  });
});

describe('corePost', () => {
  it('sends a JSON body with the same auth', async () => {
    let method = '';
    let body = '';
    const result = await corePost('/v1/system/restart', {}, {
      env,
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        method = init?.method ?? '';
        body = String(init?.body ?? '');
        return jsonResponse({ ok: true, data: { action: 'restart' } });
      }) as typeof fetch,
    });
    expect(method).toBe('POST');
    expect(body).toBe('{}');
    expect(result.state).toBe('ok');
  });
});
