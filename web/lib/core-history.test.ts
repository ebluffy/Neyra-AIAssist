// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { proxyHistoryRequest } from './core-history';

vi.mock('./auth', () => ({
  getAuth: () => ({
    api: {
      getSession: vi.fn(async ({ headers }: { headers: Headers }) => {
        const authHeader = headers.get('authorization');
        if (authHeader === 'Bearer valid-user-token') {
          return {
            user: { id: 'usr-123', name: 'Тестовый Пользователь', email: 'user@example.com', role: 'user' },
          };
        }
        return null;
      }),
    },
  }),
}));

vi.mock('./env', () => ({
  readChatEnv: () => ({
    wsUrl: 'ws://127.0.0.1:8000',
    serviceKey: 'test-service-key',
    jwtSecret: 'test-jwt-secret-at-least-32-chars-long!',
    jwtIssuer: 'neyra-web',
  }),
}));

describe('core-history proxyHistoryRequest', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns 401 when request is unauthenticated', async () => {
    const req = new Request('http://localhost:3000/api/threads');
    const res = await proxyHistoryRequest(req, '/v1/threads');
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('unauthorized');
  });

  it('proxies GET request with query params and identity headers to core', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};

    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedHeaders = (init?.headers as Record<string, string>) || {};
      return new Response(JSON.stringify({ items: [{ id: 'th-1', title: 'Test Thread' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const req = new Request('http://localhost:3000/api/threads?limit=10&cursor=cur1', {
      headers: { authorization: 'Bearer valid-user-token' },
    });

    const res = await proxyHistoryRequest(req, '/v1/threads', {
      method: 'GET',
      query: { limit: '10', cursor: 'cur1' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(capturedUrl).toContain('http://127.0.0.1:8000/v1/threads?');
    expect(capturedUrl).toContain('limit=10');
    expect(capturedUrl).toContain('cursor=cur1');
    expect(capturedHeaders['authorization'] || capturedHeaders['Authorization']).toBe('Bearer test-service-key');
    expect(capturedHeaders['x-neyra-identity'] || capturedHeaders['X-Neyra-Identity']).toBeTruthy();
  });

  it('preserves 404 response without converting to 500', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      return new Response(JSON.stringify({ error: 'not_found', message: 'Thread not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const req = new Request('http://localhost:3000/api/threads/missing-id', {
      headers: { authorization: 'Bearer valid-user-token' },
    });

    const res = await proxyHistoryRequest(req, '/v1/threads/missing-id');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('not_found');
  });

  it('returns 502 Bad Gateway when core is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:8000');
    }));

    const req = new Request('http://localhost:3000/api/threads', {
      headers: { authorization: 'Bearer valid-user-token' },
    });

    const res = await proxyHistoryRequest(req, '/v1/threads');
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe('core_unavailable');
    expect(body.message).toContain('недоступен');
  });
});
