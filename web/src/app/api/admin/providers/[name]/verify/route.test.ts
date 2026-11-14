import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { POST } from './route';

// Mock requireAdmin to authenticate as admin
vi.mock('../../../../../../../lib/admin-guard', () => ({
  requireAdmin: vi.fn(async () => ({
    ok: true,
    user: { id: 'admin-1', role: 'admin', email: 'admin@neyra.local' },
  })),
}));

// Mock readProviders from admin-providers
vi.mock('../../../../../../../lib/admin-providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../../../../lib/admin-providers')>();
  return {
    ...actual,
    readProviders: vi.fn(async () => ({
      state: 'ok',
      data: {
        providers: [
          {
            name: 'openrouter',
            label: 'OpenRouter',
            base_url: 'https://openrouter.ai/api/v1',
            kind: 'openai',
            builtin: true,
            has_key: true,
            key_source: 'vault',
            lanes: ['smart'],
          },
          {
            name: 'ollama',
            label: 'Ollama',
            base_url: 'http://localhost:11434/v1',
            kind: 'local',
            builtin: true,
            has_key: false,
            key_source: 'none',
            lanes: [],
          },
        ],
        presets: [],
        lanes: [],
      },
    })),
  };
});

describe('POST /api/admin/providers/[name]/verify', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('rejects invalid provider name with 400', async () => {
    const req = new Request('http://localhost/api/admin/providers/INVALID$$NAME/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_url: 'https://api.openai.com/v1' }),
    });

    const res = await POST(req, { params: Promise.resolve({ name: 'INVALID$$NAME' }) });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('invalid_provider');
  });

  it('returns ok: true with models count and latency on 200 response', async () => {
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof Request ? url.url : url.toString();
      expect(urlStr).toBe('https://api.openai.com/v1/models');
      return new Response(
        JSON.stringify({
          data: [
            { id: 'gpt-4o', name: 'GPT-4o' },
            { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const req = new Request('http://localhost/api/admin/providers/openai/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        base_url: 'https://api.openai.com/v1',
        api_key: 'sk-test-mock-key',
      }),
    });

    const res = await POST(req, { params: Promise.resolve({ name: 'openai' }) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.models_count).toBe(2);
    expect(json.models).toEqual([
      { id: 'gpt-4o', name: 'GPT-4o' },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
    ]);
    expect(typeof json.latency_ms).toBe('number');
  });

  it('returns normalized unauthorized error on 401 status from provider', async () => {
    global.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({ error: { message: 'Invalid API key provided.' } }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const req = new Request('http://localhost/api/admin/providers/openai/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        base_url: 'https://api.openai.com/v1',
        api_key: 'sk-wrong-key',
      }),
    });

    const res = await POST(req, { params: Promise.resolve({ name: 'openai' }) });
    expect(res.status).toBe(200); // BFF contract returns JSON envelope
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error).toBe('unauthorized');
    expect(json.status_code).toBe(401);
  });

  it('resolves base_url from core config if not provided in body', async () => {
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof Request ? url.url : url.toString();
      expect(urlStr).toBe('https://openrouter.ai/api/v1/models');
      return new Response(
        JSON.stringify({
          data: [{ id: 'anthropic/claude-3.5-sonnet' }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const req = new Request('http://localhost/api/admin/providers/openrouter/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: 'sk-or-test' }),
    });

    const res = await POST(req, { params: Promise.resolve({ name: 'openrouter' }) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.models_count).toBe(1);
  });

  it('adds warning when using non-localhost HTTP', async () => {
    global.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });

    const req = new Request('http://localhost/api/admin/providers/remotehttp/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_url: 'http://192.168.1.100:8000/v1' }),
    });

    const res = await POST(req, { params: Promise.resolve({ name: 'remotehttp' }) });
    const json = await res.json();
    expect(json.warning).toBeDefined();
    expect(json.warning).toContain('незащищённое соединение HTTP');
  });

  it('handles network error gracefully and returns unreachable error', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('Connection refused');
    });

    const req = new Request('http://localhost/api/admin/providers/dead/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_url: 'http://localhost:9999/v1' }),
    });

    const res = await POST(req, { params: Promise.resolve({ name: 'dead' }) });
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error).toBe('unreachable');
    expect(json.message).toContain('Connection refused');
  });
});
