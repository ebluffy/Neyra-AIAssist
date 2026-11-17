import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { lookup } from 'node:dns/promises';
import * as undici from 'undici';
import { POST, executePinnedProbe } from './route';
import { readProviders } from '../../../../../../../lib/admin-providers';

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return {
    ...actual,
    fetch: vi.fn((...args: Parameters<typeof actual.fetch>) => actual.fetch(...args)),
  };
});

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}));

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
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  it('AR-82: executePinnedProbe uses real undici Agent and resolves via pinned address without mocking fetch', async () => {
    const http = await import('node:http');
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'gpt-4o-real' }] }));
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    try {
      // Host pinned.invalid does NOT exist in DNS, but will be resolved to 127.0.0.1 via pinnedList
      const response = await executePinnedProbe(
        `http://pinned.invalid:${port}/models`,
        { Accept: 'application/json' },
        [{ address: '127.0.0.1', family: 4 }],
        3000,
      );
      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json).toEqual({ data: [{ id: 'gpt-4o-real' }] });
    } finally {
      server.close();
    }
  });

  it('returns ok: true with models count and latency on 200 response', async () => {
    vi.mocked(undici.fetch).mockImplementation(async (url: string | URL | undici.Request) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      expect(urlStr).toBe('https://api.openai.com/v1/models');
      return new Response(
        JSON.stringify({
          data: [
            { id: 'gpt-4o', name: 'GPT-4o' },
            { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ) as unknown as undici.Response;
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
    vi.mocked(undici.fetch).mockImplementation(async () => {
      return new Response(
        JSON.stringify({ error: { message: 'Invalid API key provided.' } }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      ) as unknown as undici.Response;
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
    vi.mocked(undici.fetch).mockImplementation(async (url: string | URL | undici.Request) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      expect(urlStr).toBe('https://openrouter.ai/api/v1/models');
      return new Response(
        JSON.stringify({
          data: [{ id: 'anthropic/claude-3.5-sonnet' }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ) as unknown as undici.Response;
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

  it('blocks targets inside the private network (AR-70)', async () => {
    vi.mocked(lookup).mockResolvedValueOnce([{ address: '192.168.1.100', family: 4 }] as never);
    const fetchMock = vi.mocked(undici.fetch);

    const req = new Request('http://localhost/api/admin/providers/remotehttp/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_url: 'http://192.168.1.100:8000/v1' }),
    });

    const res = await POST(req, { params: Promise.resolve({ name: 'remotehttp' }) });
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error).toBe('blocked_target');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks the cloud metadata address (AR-70)', async () => {
    vi.mocked(lookup).mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }] as never);
    const req = new Request('http://localhost/api/admin/providers/meta/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_url: 'http://169.254.169.254/latest' }),
    });

    const res = await POST(req, { params: Promise.resolve({ name: 'meta' }) });
    const json = await res.json();
    expect(json.error).toBe('blocked_target');
  });

  it('blocks /providers/local/verify when local provider is not saved in core (AR-70)', async () => {
    vi.mocked(lookup).mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }] as never);
    const fetchMock = vi.mocked(undici.fetch);

    const req = new Request('http://localhost/api/admin/providers/local/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_url: 'http://127.0.0.1:8787' }),
    });

    const res = await POST(req, { params: Promise.resolve({ name: 'local' }) });
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error).toBe('blocked_target');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks IPv4-mapped IPv6 address ::ffff:7f00:1 (AR-70)', async () => {
    vi.mocked(lookup).mockResolvedValueOnce([{ address: '::ffff:7f00:1', family: 6 }] as never);
    const fetchMock = vi.mocked(undici.fetch);

    const req = new Request('http://localhost/api/admin/providers/custom/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_url: 'http://[::ffff:7f00:1]:8000/v1' }),
    });

    const res = await POST(req, { params: Promise.resolve({ name: 'custom' }) });
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error).toBe('blocked_target');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks CGNAT / Tailscale 100.64.0.1 (AR-70)', async () => {
    vi.mocked(lookup).mockResolvedValueOnce([{ address: '100.64.0.1', family: 4 }] as never);
    const fetchMock = vi.mocked(undici.fetch);

    const req = new Request('http://localhost/api/admin/providers/custom/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_url: 'http://100.64.0.1:8000/v1' }),
    });

    const res = await POST(req, { params: Promise.resolve({ name: 'custom' }) });
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error).toBe('blocked_target');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks benchmarking network 198.18.0.1 (AR-70)', async () => {
    vi.mocked(lookup).mockResolvedValueOnce([{ address: '198.18.0.1', family: 4 }] as never);
    const fetchMock = vi.mocked(undici.fetch);

    const req = new Request('http://localhost/api/admin/providers/custom/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_url: 'http://198.18.0.1:8000/v1' }),
    });

    const res = await POST(req, { params: Promise.resolve({ name: 'custom' }) });
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error).toBe('blocked_target');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not verify a saved key by sending it from the site even when UI sends base_url (AR-69)', async () => {
    const fetchMock = vi.mocked(undici.fetch);

    // UI actually sends { base_url: p.base_url, api_key: undefined }
    const req = new Request('http://localhost/api/admin/providers/openrouter/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        base_url: 'https://openrouter.ai/api/v1',
      }),
    });

    const res = await POST(req, { params: Promise.resolve({ name: 'openrouter' }) });
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error).toBe('key_in_core');
    expect(json.source).toBe('core_probe');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns core_probe status when probe is present for saved provider without api_key (AR-69)', async () => {
    vi.mocked(readProviders).mockResolvedValueOnce({
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
            probe: {
              state: 'open',
              models: 42,
              message: 'Соединение проверено ядром.',
            },
          },
        ],
        presets: [],
        lanes: [],
      },
    } as never);

    const fetchMock = vi.mocked(undici.fetch);

    const req = new Request('http://localhost/api/admin/providers/openrouter/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        base_url: 'https://openrouter.ai/api/v1',
      }),
    });

    const res = await POST(req, { params: Promise.resolve({ name: 'openrouter' }) });
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.source).toBe('core_probe');
    expect(json.models_count).toBe(42);
    expect(json.message).toBe('Соединение проверено ядром.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('handles network error gracefully and does not leak the exception text (AR-70)', async () => {
    vi.mocked(undici.fetch).mockImplementation(async () => {
      throw new Error('Connection refused at 127.0.0.1:8787');
    });

    const req = new Request('http://localhost/api/admin/providers/dead/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_url: 'https://dead.example.test/v1' }),
    });

    const res = await POST(req, { params: Promise.resolve({ name: 'dead' }) });
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error).toBe('unreachable');
    expect(json.message).not.toContain('Connection refused');
    expect(json.message).not.toContain('127.0.0.1');
  });
});
