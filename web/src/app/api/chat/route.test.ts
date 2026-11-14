import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { POST } from './route';
import { verifyIdentityToken } from '../../../../lib/identity';
import { getAuth } from '../../../../lib/auth';
import { CHAT_REQUESTS_PER_WINDOW, resetChatLimitsForTests } from '../../../../lib/chat-limits';

const factory = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('../../../../lib/auth', () => ({ getAuth: vi.fn() }));
vi.mock('ws', () => ({ default: class {
  static CONNECTING = 0;
  static OPEN = 1;
  constructor(url: string, options: unknown) { return factory.create(url, options); }
} }));

type FakeSocket = EventEmitter & {
  readyState: number;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
};

describe('POST /api/chat WebSocket → SSE bridge (no network)', () => {
  const jwtSecret = 'public-test-fixture-at-least-32-characters-long';
  const validUuid = '11111111-1111-4111-8111-111111111111';
  let socket: FakeSocket;

  beforeEach(() => {
    vi.clearAllMocks();
    resetChatLimitsForTests();
    vi.stubEnv('NEYRA_WS_URL', 'wss://core.test');
    vi.stubEnv('NEYRA_SERVICE_KEY', 'public-test-service-key');
    vi.stubEnv('NEYRA_IDENTITY_JWT_SECRET', jwtSecret);
    vi.stubEnv('NEYRA_IDENTITY_JWT_ISSUER', 'neyra-web');
    socket = new EventEmitter() as FakeSocket;
    socket.readyState = 0;
    socket.send = vi.fn((_data, callback) => callback?.());
    socket.close = vi.fn(() => { socket.readyState = 3; socket.emit('close', 1000); });
    socket.terminate = vi.fn(() => { socket.readyState = 3; socket.emit('close', 1006); });
    factory.create.mockReset().mockReturnValue(socket);
    vi.mocked(getAuth).mockReturnValue({ api: { getSession: vi.fn().mockResolvedValue({
      user: { id: 'usr-42', name: 'Алиса', email: 'alice@example.test', role: 'admin' },
    }) } } as unknown as ReturnType<typeof getAuth>);
  });

  afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

  function request(signal?: AbortSignal, body: unknown = { text: 'Привет!', chat_id: validUuid }) {
    return new Request('http://localhost/api/chat', { method: 'POST', body: JSON.stringify(body), signal });
  }
  function message(event: unknown) { socket.emit('message', Buffer.from(JSON.stringify(event)), false); }
  async function connecting(signal?: AbortSignal, body?: unknown) {
    const pending = POST(request(signal, body));
    await vi.waitFor(() => expect(factory.create).toHaveBeenCalledTimes(1));
    return { pending };
  }
  async function hello(signal?: AbortSignal, body?: unknown) {
    const { pending } = await connecting(signal, body);
    socket.readyState = 1;
    socket.emit('open');
    expect(socket.send).not.toHaveBeenCalled();
    message({ type: 'hello', protocol: 'neyra.ws.chat.v1' });
    return pending;
  }

  it('returns 401 without a session and never connects to core', async () => {
    vi.mocked(getAuth).mockReturnValue({ api: { getSession: vi.fn().mockResolvedValue(null) } } as unknown as ReturnType<typeof getAuth>);
    expect((await POST(request())).status).toBe(401);
    expect(factory.create).not.toHaveBeenCalled();
  });

  it('does not accept the x-smoke-test bypass in production code (AR-16)', async () => {
    vi.stubEnv('SMOKE_TEST', '1');
    vi.mocked(getAuth).mockReturnValue({ api: { getSession: vi.fn().mockResolvedValue(null) } } as unknown as ReturnType<typeof getAuth>);
    const response = await POST(new Request('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-smoke-test': '1' },
      body: JSON.stringify({ text: 'Привет!', chat_id: validUuid }),
    }));
    expect(response.status).toBe(401);
    expect(factory.create).not.toHaveBeenCalled();
  });

  it('forwards stored attachments into the WS chat frame and rejects foreign shapes (AR-14)', async () => {
    const stored = { id: 'a'.repeat(32), kind: 'image', mime: 'image/png', name: 'cat.png', size: 5 };
    const response = await hello(undefined, { text: 'Привет!', chat_id: validUuid, attachments: [stored] });
    message({ type: 'done', text: 'ok' });
    expect(response.status).toBe(200);
    expect(JSON.parse(socket.send.mock.calls[0][0])).toMatchObject({ attachments: [stored] });

    resetChatLimitsForTests();
    const bad = await POST(request(undefined, {
      text: 'Привет!',
      chat_id: validUuid,
      attachments: [{ id: crypto.randomUUID(), name: 'cat.png', size: 5, isImage: true }],
    }));
    expect(bad.status).toBe(400);
  });

  it('passes phase and usage from the core and keeps the indicator data intact (AR-15)', async () => {
    const response = await hello();
    message({ type: 'phase', phase: 'retrieval', label: 'Собираю контекст…' });
    message({ type: 'token', text: 'ответ' });
    message({
      type: 'done',
      text: 'ответ',
      usage: { total: { used: 10, limit: 100 }, lanes: { talk: { used: 10, limit: 100 }, brain: {} } },
    });
    const text = await response.text();
    expect(text).toContain('data: {"type":"phase","phase":"retrieval","label":"Собираю контекст…"}\n\n');
    expect(text).toContain('"usage":{"total":{"used":10,"limit":100},"lanes":{"talk":{"used":10,"limit":100},"brain":{}}}');
  });

  it('limits chat requests per user to a minute window (AR-17)', async () => {
    for (let i = 0; i < CHAT_REQUESTS_PER_WINDOW; i++) {
      expect((await POST(request(undefined, { text: '' }))).status).toBe(400);
    }
    const blocked = await POST(request());
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBeTruthy();
    expect(await blocked.json()).toMatchObject({ error: 'rate_limited' });
    expect(factory.create).not.toHaveBeenCalled();
  });

  it('keeps empty-text validation before transport', async () => {
    expect((await POST(request(undefined, { text: '   ' }))).status).toBe(400);
    expect(factory.create).not.toHaveBeenCalled();
  });

  it('rejects text exceeding 6000 characters with 400 bad_request (AR-4)', async () => {
    expect((await POST(request(undefined, { text: 'a'.repeat(6001) }))).status).toBe(400);
    expect(factory.create).not.toHaveBeenCalled();
  });

  it('rejects invalid non-UUID chat_id with 400 bad_request (AR-1)', async () => {
    expect((await POST(request(undefined, { text: 'Привет', chat_id: 'not-a-valid-uuid' }))).status).toBe(400);
    expect(factory.create).not.toHaveBeenCalled();
  });

  it('isolates channels by prefixing web:userId to channel_id even if foreign chat_id is passed (AR-1)', async () => {
    vi.mocked(getAuth).mockReturnValue({ api: { getSession: vi.fn().mockResolvedValue({
      user: { id: 'other-user', name: 'Боб', email: 'bob@example.test', role: 'user' },
    }) } } as unknown as ReturnType<typeof getAuth>);
    await hello();
    expect(JSON.parse(socket.send.mock.calls[0][0]).channel_id).toBe(`web:other-user:${validUuid}`);
  });

  it('converts hello → token → thinking → done to SSE, sends scoped channel_id and signed headers, strips leaks (AR-1, AR-2, AR-6)', async () => {
    const response = await hello();
    const [url, options] = factory.create.mock.calls[0];
    expect(url).toBe('wss://core.test/v1/ws/chat');
    expect(options.headers.Authorization).toBe('Bearer public-test-service-key');
    const { payload } = await verifyIdentityToken(options.headers['X-Neyra-Identity'], jwtSecret);
    expect(payload).toMatchObject({
      iss: 'neyra-web',
      sub: 'usr-42',
      role: 'admin',
      name: 'Алиса',
      chat_id: `web:usr-42:${validUuid}`,
      task: 'chat',
    });
    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(socket.send.mock.calls[0][0])).toEqual({
      type: 'chat',
      text: 'Привет!',
      username: 'alice@example.test',
      platform_user_id: 'usr-42',
      channel_id: `web:usr-42:${validUuid}`,
    });

    message({ type: 'pong' });
    message({ type: 'token', text: 'Привет, ' });
    message({ type: 'thinking', text: 'думаю...' });
    message({ type: 'token', text: 'мир!' });
    // core sends done with internal thoughts and model_trace: must NOT leak into SSE output
    message({ type: 'done', text: 'Привет, мир!', sounds: ['s1'], thoughts: 'internal_thoughts', model_trace: { trace: 'secret' } });
    message({ type: 'token', text: 'late' });
    socket.emit('error', new Error('late error'));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('cache-control')).toContain('no-cache');
    expect(response.headers.get('x-accel-buffering')).toBe('no');

    const responseText = await response.text();
    expect(responseText).toContain('data: {"type":"token","text":"Привет, "}\n\n');
    expect(responseText).toContain('data: {"type":"thinking","text":"думаю..."}\n\n');
    expect(responseText).toContain('data: {"type":"token","text":"мир!"}\n\n');
    expect(responseText).toContain('data: {"type":"done","text":"Привет, мир!"}\n\n');

    // Crucial check: verify that model_trace, thoughts, sounds are stripped
    expect(responseText).not.toContain('internal_thoughts');
    expect(responseText).not.toContain('model_trace');
    expect(responseText).not.toContain('secret');
    expect(responseText).not.toContain('sounds');

    expect(socket.close).toHaveBeenCalledOnce();
  });

  it('sanitizes error events from core: masks raw message and omits model_trace (AR-2)', async () => {
    const response = await hello();
    message({
      type: 'error',
      code: 'chat_error',
      message: 'RAW_DATABASE_EXCEPTION: column missing at /opt/neyra/core.py line 42',
      model_trace: { raw: 'trace_info' },
    });

    const responseText = await response.text();
    expect(responseText).not.toContain('RAW_DATABASE_EXCEPTION');
    expect(responseText).not.toContain('model_trace');
    expect(responseText).not.toContain('trace_info');
    expect(responseText).toContain('"type":"error"');
    expect(responseText).toContain('"code":"chat_error"');
    expect(responseText).toContain('"message":"Ошибка при обработке сообщения в ядре."');
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it('passes the core provider rate-limit reason through (wave 3)', async () => {
    const response = await hello();
    message({
      type: 'error',
      code: 'provider_rate_limit',
      message: 'Провайдер моделей ограничил запросы (429). Попробуйте позже — лимит сбрасывается автоматически.',
      model_trace: { raw: 'trace_info' },
    });

    const responseText = await response.text();
    expect(responseText).toContain('"code":"provider_rate_limit"');
    expect(responseText).toContain('429');
    expect(responseText).not.toContain('model_trace');
    expect(responseText).not.toContain('trace_info');
  });

  it('keeps the generic text for codes outside the user-facing list', async () => {
    const response = await hello();
    message({
      type: 'error',
      code: 'internal_chat_error',
      message: 'RAW_DATABASE_EXCEPTION: /opt/neyra/core.py line 42',
    });

    const responseText = await response.text();
    expect(responseText).not.toContain('RAW_DATABASE_EXCEPTION');
    expect(responseText).toContain('"message":"Ошибка при обработке сообщения в ядре."');
  });

  it('triggers core_timeout on 30s silence after hello (AR-3)', async () => {
    vi.useFakeTimers();
    const response = await hello();
    await vi.advanceTimersByTimeAsync(30_000);
    const responseText = await response.text();
    expect(responseText).toContain('"code":"core_timeout"');
    expect(responseText).toContain('"message":"Ядро Нейры не ответило вовремя. Попробуйте позже."');
    expect(socket.terminate).toHaveBeenCalledOnce();
  });

  it('aborts a connecting socket when the request is cancelled', async () => {
    const controller = new AbortController();
    const { pending } = await connecting(controller.signal);
    controller.abort();
    expect((await pending).status).toBe(499);
    expect(socket.terminate).toHaveBeenCalledOnce();
    expect(socket.send).not.toHaveBeenCalled();
  });

  it('aborts the WS and ends an active SSE stream on request.signal', async () => {
    const controller = new AbortController();
    const response = await hello(controller.signal);
    controller.abort();
    message({ type: 'token', text: 'late' });
    expect(await response.text()).toBe('');
    expect(socket.terminate).toHaveBeenCalledOnce();
  });

  it('cancels WS when the response reader cancels', async () => {
    const response = await hello();
    await response.body!.cancel();
    expect(socket.terminate).toHaveBeenCalledOnce();
    message({ type: 'token', text: 'late' });
  });

  it('never opens a socket for a request already aborted', async () => {
    const controller = new AbortController(); controller.abort();
    expect((await POST(request(controller.signal))).status).toBe(499);
    expect(factory.create).not.toHaveBeenCalled();
  });

  it('returns a safe 502 on a rejected WebSocket upgrade', async () => {
    const { pending } = await connecting();
    socket.emit('error', new Error('Unexpected server response: 401 SECRET'));
    const response = await pending;
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('SECRET');
    expect(socket.terminate).toHaveBeenCalledOnce();
  });

  it('returns 502 on synchronous connection failure', async () => {
    factory.create.mockImplementation(() => { throw new Error('bad connection'); });
    expect((await POST(request())).status).toBe(502);
  });

  it('returns 504 if a connected core never sends hello', async () => {
    vi.useFakeTimers();
    const { pending } = await connecting();
    socket.readyState = 1; socket.emit('open');
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await pending).status).toBe(504);
    expect(socket.terminate).toHaveBeenCalledOnce();
  });

  it('returns 502 if core closes before hello', async () => {
    const { pending } = await connecting();
    socket.readyState = 3; socket.emit('close');
    expect((await pending).status).toBe(502);
  });

  it('emits an SSE error for an unexpected close after hello', async () => {
    const response = await hello();
    socket.readyState = 3; socket.emit('close');
    expect(await response.text()).toContain('"code":"core_disconnected"');
  });

  it('handles send callback failure as terminal SSE error', async () => {
    socket.send.mockImplementation((_data, callback) => callback(new Error('send failed')));
    const response = await hello();
    expect(await response.text()).toContain('"code":"core_unavailable"');
    expect(socket.terminate).toHaveBeenCalledOnce();
  });

  it('handles malformed frames after hello as terminal SSE errors', async () => {
    const response = await hello();
    socket.emit('message', Buffer.from('not json'), false);
    expect(await response.text()).toContain('"code":"core_protocol_error"');
    expect(socket.terminate).toHaveBeenCalledOnce();
  });

  it('rejects missing service key and invalid WS configuration before connection', async () => {
    vi.stubEnv('NEYRA_SERVICE_KEY', '');
    expect((await POST(request())).status).toBe(500);
    vi.stubEnv('NEYRA_SERVICE_KEY', 'fixture'); vi.stubEnv('NEYRA_WS_URL', 'https://core.test');
    expect((await POST(request())).status).toBe(500);
    expect(factory.create).not.toHaveBeenCalled();
  });

  it('rejects short JWT secret with 500 configuration_error (AR-8)', async () => {
    vi.stubEnv('NEYRA_IDENTITY_JWT_SECRET', 'short-secret');
    expect((await POST(request())).status).toBe(500);
    expect(factory.create).not.toHaveBeenCalled();
  });
});
