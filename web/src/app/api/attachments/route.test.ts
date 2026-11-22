import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from './route';
import { getAuth } from '../../../../lib/auth';
import { verifyIdentityToken } from '../../../../lib/identity';
import {
  UPLOAD_QUOTA_BYTES,
  UPLOAD_REQUESTS_PER_WINDOW,
  recordUpload,
  resetUploadLimitsForTests,
  uploadQuotaUsed,
} from '../../../../lib/upload-limits';

vi.mock('../../../../lib/auth', () => ({ getAuth: vi.fn() }));

const jwtSecret = 'public-test-fixture-at-least-32-characters-long';
const chatId = '11111111-1111-4111-8111-111111111111';
const attachment = {
  id: 'a'.repeat(32),
  kind: 'image',
  mime: 'image/png',
  name: 'cat.png',
  size: 5,
};

function session() {
  return {
    user: { id: 'usr-42', name: 'Алиса', email: 'alice@example.test', role: 'admin' },
  };
}

// Браузер сам ставит Content-Length для multipart; в тесте собираем тело заранее,
// чтобы проверять 411/413 так же, как на реальном запросе.
async function formRequest(files: File[], id = chatId): Promise<Request> {
  const form = new FormData();
  if (id) form.set('chat_id', id);
  for (const file of files) form.append('files', file, file.name);
  const encoded = new Response(form);
  const body = await encoded.arrayBuffer();
  const contentType = encoded.headers.get('content-type') || 'multipart/form-data';
  return new Request('http://localhost/api/attachments', {
    method: 'POST',
    headers: {
      'content-type': contentType,
      'content-length': String(body.byteLength),
    },
    body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  resetUploadLimitsForTests();
  vi.stubEnv('NEYRA_API_URL', 'http://core.test');
  vi.stubEnv('NEYRA_WEB_KEY', 'service-key');
  vi.stubEnv('NEYRA_IDENTITY_JWT_SECRET', jwtSecret);
  vi.stubEnv('NEYRA_IDENTITY_JWT_ISSUER', 'neyra-web');
  vi.mocked(getAuth).mockReturnValue({
    api: { getSession: vi.fn().mockResolvedValue(session()) },
  } as unknown as ReturnType<typeof getAuth>);
});

describe('POST /api/attachments', () => {
  it('does not upload with the admin key alone (AR-36)', async () => {
    vi.stubEnv('NEYRA_WEB_KEY', '');
    vi.stubEnv('NEYRA_ADMIN_KEY', 'admin-key');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const response = await POST(await formRequest([new File(['x'], 'a.txt', { type: 'text/plain' })]));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'attachments_unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 401 without a session', async () => {
    vi.mocked(getAuth).mockReturnValue({
      api: { getSession: vi.fn().mockResolvedValue(null) },
    } as unknown as ReturnType<typeof getAuth>);
    const response = await POST(await formRequest([new File(['hello'], 'a.txt', { type: 'text/plain' })]));
    expect(response.status).toBe(401);
  });

  it('requires Content-Length before reading the body (AR-26)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const request = new Request('http://localhost/api/attachments', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
      body: 'x',
    });
    const response = await POST(request);
    expect(response.status).toBe(411);
    expect(await response.json()).toMatchObject({ error: 'length_required' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a declared body over the limit with 413 before reading it (AR-26)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const request = new Request('http://localhost/api/attachments', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=x', 'content-length': String(64 * 1024 * 1024) },
      body: 'x',
    });
    const response = await POST(request);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: 'attachment_size' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uploads a real multipart form to the core with identity and the web channel', async () => {
    let seenUrl = '';
    let seenHeaders = new Headers();
    let seenChannel = '';
    let seenFileName = '';
    let seenFileText = '';
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(url);
      seenHeaders = new Headers(init?.headers);
      const body = init?.body as FormData;
      seenChannel = String(body.get('channel_id'));
      const file = body.getAll('files')[0] as File;
      seenFileName = file.name;
      seenFileText = await file.text();
      return new Response(JSON.stringify({ ok: true, data: { attachments: [attachment] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));

    const response = await POST(await formRequest([new File(['hello'], 'cat.png', { type: 'image/png' })]));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ attachments: [attachment] });

    expect(seenUrl).toBe('http://core.test/v1/attachments');
    expect(seenHeaders.get('authorization')).toBe('Bearer service-key');
    expect(seenChannel).toBe(`web:usr-42:${chatId}`);
    expect(seenFileName).toBe('cat.png');
    expect(seenFileText).toBe('hello');

    const token = seenHeaders.get('x-neyra-identity');
    expect(token).toBeTruthy();
    const verified = await verifyIdentityToken(token!, jwtSecret, { issuer: 'neyra-web' });
    expect(verified.payload).toMatchObject({
      sub: 'usr-42',
      role: 'admin',
      chat_id: `web:usr-42:${chatId}`,
      task: 'attachment',
    });
  });

  it('rejects invalid count and unsigned chat id before calling the core', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const five = Array.from({ length: 5 }, (_, i) => new File(['x'], `f${i}.txt`, { type: 'text/plain' }));
    expect((await POST(await formRequest(five))).status).toBe(400);
    expect((await POST(await formRequest([new File(['x'], 'a.txt', { type: 'text/plain' })], 'not-a-uuid'))).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('limits upload requests per user to a minute window (AR-26)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, data: { attachments: [attachment] } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));
    const file = new File(['hello'], 'cat.png', { type: 'image/png' });
    for (let i = 0; i < UPLOAD_REQUESTS_PER_WINDOW; i++) {
      expect((await POST(await formRequest([file]))).status).toBe(200);
    }
    const blocked = await POST(await formRequest([file]));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBeTruthy();
    expect(await blocked.json()).toMatchObject({ error: 'rate_limited' });
  });

  it('releases the reserved quota when the core upload fails (AR-34)', async () => {
    recordUpload('usr-42', UPLOAD_QUOTA_BYTES - 10);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail: 'Not Found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    })));
    const response = await POST(await formRequest([new File(['hello'], 'a.txt', { type: 'text/plain' })]));
    expect(response.status).toBe(503);
    expect(uploadQuotaUsed('usr-42')).toBe(UPLOAD_QUOTA_BYTES - 10);
  });

  it('maps a missing core endpoint to a calm 503 without leaking a 404', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail: 'Not Found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    })));
    const response = await POST(await formRequest([new File(['x'], 'a.txt', { type: 'text/plain' })]));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'attachments_unavailable' });
  });

  it('passes a public core rejection message and status through', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      error: { code: 'attachment_type', message: 'Этот тип файла не поддерживается.' },
    }), {
      status: 415,
      headers: { 'content-type': 'application/json' },
    })));
    const response = await POST(await formRequest([new File(['x'], 'a.exe', { type: 'application/octet-stream' })]));
    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({
      error: 'attachment_type',
      message: 'Этот тип файла не поддерживается.',
    });
  });

  it('passes the linked Discord account id into the identity JWT (AR-4)', async () => {
    vi.mocked(getAuth).mockReturnValue({ api: {
      getSession: vi.fn().mockResolvedValue(session()),
      listUserAccounts: vi.fn().mockResolvedValue([{ providerId: 'discord', accountId: 'discord-user-1' }]),
    } } as unknown as ReturnType<typeof getAuth>);
    let seenHeaders: Headers | null = null;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      seenHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ ok: true, data: { attachments: [attachment] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));
    const response = await POST(await formRequest([new File(['hello'], 'cat.png', { type: 'image/png' })]));
    expect(response.status).toBe(200);
    const token = seenHeaders!.get('x-neyra-identity');
    const verified = await verifyIdentityToken(token!, jwtSecret, { issuer: 'neyra-web' });
    expect(verified.payload.discord_id).toBe('discord-user-1');
  });
});


describe('GET /api/attachments', () => {
  it('reports availability from server configuration without calling the core', async () => {
    const response = await GET();
    expect(await response.json()).toEqual({ available: true });
    vi.stubEnv('NEYRA_API_URL', '');
    const unavailable = await GET();
    expect(await unavailable.json()).toMatchObject({ available: false });
  });
});
