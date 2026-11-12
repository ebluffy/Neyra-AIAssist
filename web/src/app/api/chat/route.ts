import { NextResponse } from 'next/server';
import WebSocket from 'ws';
import { getAuth } from '../../../../lib/auth';
import { readChatEnv } from '../../../../lib/env';
import { createIdentityToken } from '../../../../lib/identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let session;
  try {
    session = await getAuth().api.getSession({ headers: request.headers });
  } catch {
    return NextResponse.json(
      { error: 'auth_unavailable', message: 'Сервис аутентификации временно недоступен.' },
      { status: 503 }
    );
  }

  if (!session || !session.user) {
    return NextResponse.json(
      { error: 'unauthorized', message: 'Требуется авторизация для доступа к чату.' },
      { status: 401 }
    );
  }

  let body: { text?: string; chat_id?: string; model?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'bad_request', message: 'Неверный формат запроса (ожидался JSON).' },
      { status: 400 }
    );
  }

  const text = body && typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) {
    return NextResponse.json(
      { error: 'empty_text', message: 'Текст сообщения не может быть пустым.' },
      { status: 400 }
    );
  }

  let env: ReturnType<typeof readChatEnv>;
  try { env = readChatEnv(); } catch {
    return NextResponse.json({ error: 'configuration_error', message: 'Некорректный WS URL ядра Нейры.' }, { status: 500 });
  }
  const { wsUrl, serviceKey, jwtSecret } = env;
  if (!jwtSecret || !serviceKey) {
    return NextResponse.json(
      { error: 'configuration_error', message: 'Не настроен service key или секрет идентичности ядра Нейры.' },
      { status: 500 }
    );
  }

  const chatId = typeof body.chat_id === 'string' && body.chat_id ? body.chat_id : crypto.randomUUID();
  let identityJwt: string;
  try {
    identityJwt = await createIdentityToken(
      {
        id: session.user.id,
        role: session.user.role,
        name: session.user.name,
        email: session.user.email,
      },
      jwtSecret,
      { chat_id: chatId, task: 'chat' }
    );
  } catch {
    return NextResponse.json(
      { error: 'identity_error', message: 'Не удалось сформировать токен идентичности.' },
      { status: 500 }
    );
  }

  const payload = {
    type: 'chat', text,
    username: session.user.email,
    platform_user_id: session.user.id,
    channel_id: chatId,
  };

  return new Promise<Response>((resolve) => {
    let socket: WebSocket | undefined;
    let output: ReadableStreamDefaultController<Uint8Array>;
    let finished = false;
    let replied = false;
    let receivedHello = false;
    let cancelled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { output = controller; },
      cancel() { cancelled = true; finish(true); },
    });

    function finish(force = false) {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      request.signal.removeEventListener('abort', abort);
      if (!cancelled) output.close();
      if (socket) {
        if (force || socket.readyState === WebSocket.CONNECTING) socket.terminate();
        else if (socket.readyState === WebSocket.OPEN) socket.close(1000);
      }
    }
    function emit(event: Record<string, unknown>) {
      output.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    }
    function fail(code: string, message: string, status = 502) {
      if (finished) return;
      if (replied) emit({ type: 'error', code, message });
      else { replied = true; resolve(NextResponse.json({ error: code, message }, { status })); }
      finish(true);
    }
    function abort() {
      if (finished) return;
      if (!replied) {
        replied = true;
        resolve(NextResponse.json({ error: 'client_aborted', message: 'Запрос отменён.' }, { status: 499 }));
      }
      finish(true);
    }

    if (request.signal.aborted) { abort(); return; }
    // Covers both the HTTP upgrade and a connected peer that never sends hello.
    deadline = setTimeout(() => fail('core_timeout', 'Ядро Нейры не ответило вовремя. Попробуйте позже.', 504), 10_000);
    try {
      socket = new WebSocket(`${wsUrl}/v1/ws/chat`, {
        headers: { Authorization: `Bearer ${serviceKey}`, 'X-Neyra-Identity': identityJwt },
        handshakeTimeout: 10_000,
        maxPayload: 1024 * 1024,
      });
    } catch {
      fail('core_unavailable', 'Ядро Нейры недоступно. Попробуйте позже.');
      return;
    }
    socket.on('error', () => fail('core_unavailable', 'Соединение с ядром Нейры прервано. Попробуйте позже.'));
    socket.on('close', () => fail('core_disconnected', 'Ядро Нейры закрыло соединение до завершения ответа.'));
    socket.on('message', (data, isBinary) => {
      if (finished) return;
      let event: Record<string, unknown>;
      try {
        if (isBinary) throw new Error();
        event = JSON.parse(data.toString());
        if (!event || typeof event !== 'object') throw new Error();
      } catch {
        fail('core_protocol_error', 'Ядро Нейры вернуло некорректное сообщение.');
        return;
      }
      if (event.type === 'pong') return;
      if (event.type === 'hello') {
        if (receivedHello) return;
        receivedHello = true;
        clearTimeout(deadline);
        replied = true;
        resolve(new Response(stream, { headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'X-Accel-Buffering': 'no',
        } }));
        try {
          socket!.send(JSON.stringify(payload), error => {
            if (error) fail('core_unavailable', 'Не удалось отправить сообщение ядру Нейры.');
          });
        } catch { fail('core_unavailable', 'Не удалось отправить сообщение ядру Нейры.'); }
        return;
      }
      if (!receivedHello) {
        fail('core_protocol_error', 'Ядро Нейры не подтвердило готовность чата.');
        return;
      }
      if (!['token', 'done', 'error'].includes(String(event.type))) return;
      if ((event.type === 'token' || event.type === 'done') && typeof event.text !== 'string') {
        fail('core_protocol_error', 'Ядро Нейры вернуло некорректный текст ответа.');
        return;
      }
      emit(event);
      if (event.type === 'done' || event.type === 'error') finish();
    });
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) abort();
  });
}
