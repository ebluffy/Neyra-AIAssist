import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';

vi.mock('../../../../../lib/admin-guard', () => ({
  requireAdmin: vi.fn(async () => ({
    ok: true,
    user: { id: 'admin-1', email: 'admin@example.test', name: 'Админ', role: 'admin' },
  })),
}));

beforeEach(() => {
  vi.stubEnv('NEYRA_API_URL', 'http://core.test');
  vi.stubEnv('NEYRA_SERVICE_KEY', 'service-key');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('GET /api/admin/providers', () => {
  it('degrades softly when the core has no /v1/providers yet (AR-19)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail: 'Not Found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    })));

    const response = await GET(new Request('http://localhost/api/admin/providers'));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      data: {
        supported: false,
        providers: [],
        presets: [],
        lanes: [],
      },
    });
  });
});
