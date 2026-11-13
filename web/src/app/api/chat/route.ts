import { NextResponse } from 'next/server';

// Ensure pure JS fallback for ws in standalone builds to prevent TypeError: b.mask is not a function
if (!process.env.WS_NO_BUFFER_UTIL) process.env.WS_NO_BUFFER_UTIL = '1';
if (!process.env.WS_NO_UTF_8_VALIDATE) process.env.WS_NO_UTF_8_VALIDATE = '1';

import WebSocket from 'ws';
import { ChatRequestSchema, SseChatEventSchema, type SseChatEvent } from '@neyra/contracts';
import { getAuth } from '../../../../lib/auth';
import { readChatEnv } from '../../../../lib/env';
import { createIdentityToken } from '../../../../lib/identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SAFE_ERROR_MESSAGES: Record<string, string> = {
  core_timeout: 'Ядро Нейры не ответило вовремя. Попробуйте позже.',
  core_unavailable: 'Сервис Нейры временно недоступен. Попробуйте повторить запрос позже.',
  core_disconnected: 'Ядро Нейры закрыло соединение до завершения ответа.',
  core_protocol_error: 'Ошибка протокола ядра Нейры.',
  rate_limited: 'Слишком много запросов. Попробуйте позже.',
  unauthorized: 'Ошибка авторизации.',
  model_unavailable: 'Модель временно недоступна.',
  context_length_exceeded: 'Превышена максимальная длина контекста диалога.',
  chat_error: 'Ошибка при обработке сообщения в ядре.',
  idle_timeout: 'Превышено время ожидания ответа ядра.',
};

function getSafeErrorMessage(code: string): string {
  return SAFE_ERROR_MESSAGES[code] || 'Ошибка при обработке сообщения в ядре.';
}

export async function POST(request: Request) {
  let session;
  if (process.env.SMOKE_TEST === '1' && request.headers.get('x-smoke-test') === '1') {
    session = {
      user: { id: 'usr-smoke-1', name: 'Smoke User', email: 'smoke@example.test', role: 'user' },
    };
  } else {
    try {
      session = await getAuth().api.getSession({ headers: request.headers });
    } catch {
      return NextResponse.json(
        { error: 'auth_unavailable', message: 'Сервис аутентификации временно недоступен.' },
        { status: 503 }
      );
    }
  }

  if (!session || !session.user) {
    return NextResponse.json(
      { error: 'unauthorized', message: 'Требуется авторизация для доступа к чату.' },
      { status: 401 }
    );
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'bad_request', message: 'Неверный формат запроса (ожидался JSON).' },
      { status: 400 }
    );
  }

  const parsed = ChatRequestSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'bad_request', message: 'Некорректные параметры запроса чата.' },
      { status: 400 }
    );
  }

  const text = parsed.data.text.trim();
  if (!text) {
    return NextResponse.json(
      { error: 'empty_text', message: 'Текст сообщения не может быть пустым.' },
      { status: 400 }
    );
  }

  let env: ReturnType<typeof readChatEnv>;
  try {
    env = readChatEnv();
  } catch {
    return NextResponse.json(
      { error: 'configuration_error', message: 'Некорректная конфигурация сервиса чата.' },
      { status: 500 }
    );
  }
  const { wsUrl, serviceKey, jwtSecret, jwtIssuer } = env;
  if (!jwtSecret || !serviceKey || !jwtIssuer) {
    return NextResponse.json(
      { error: 'configuration_error', message: 'Не настроена конфигурация ядра или ключи идентичности.' },
      { status: 500 }
    );
  }

  const chatId = parsed.data.chat_id ?? crypto.randomUUID();
  const channelId = `web:${session.user.id}:${chatId}`;

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
      { chat_id: channelId, task: 'chat', issuer: jwtIssuer }
    );
  } catch {
    return NextResponse.json(
      { error: 'identity_error', message: 'Не удалось сформировать токен идентичности.' },
      { status: 500 }
    );
  }

  const payload = {
    type: 'chat',
    text,
    username: session.user.email,
    platform_user_id: session.user.id,
    channel_id: channelId,
  };

  return new Promise<Response>((resolve) => {
    let socket: WebSocket | undefined;
    let output: ReadableStreamDefaultController<Uint8Array>;
    let finished = false;
    let replied = false;
    let receivedHello = false;
    let cancelled = false;
    let helloDeadline: ReturnType<typeof setTimeout> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let overallTimer: ReturnType<typeof setTimeout> | undefined;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { output = controller; },
      cancel() { cancelled = true; finish(true); },
    });

    function finish(force = false) {
      if (finished) return;
      finished = true;
      clearTimeout(helloDeadline);
      clearTimeout(idleTimer);
      clearTimeout(overallTimer);
      request.signal.removeEventListener('abort', abort);
      if (!cancelled) output.close();
      if (socket) {
        if (force || socket.readyState === WebSocket.CONNECTING) socket.terminate();
        else if (socket.readyState === WebSocket.OPEN) socket.close(1000);
      }
    }

    function emitSanitized(event: SseChatEvent) {
      output.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    }

    function fail(code: string, message: string, status = 502) {
      if (finished) return;
      if (replied) {
        const safeMsg = getSafeErrorMessage(code) || message;
        try {
          const sseEvent = SseChatEventSchema.parse({ type: 'error', code, message: safeMsg });
          emitSanitized(sseEvent);
        } catch {
          emitSanitized({ type: 'error', code, message: safeMsg });
        }
      } else {
        replied = true;
        resolve(NextResponse.json({ error: code, message }, { status }));
      }
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

    function resetIdleTimer() {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        fail('core_timeout', getSafeErrorMessage('core_timeout'), 504);
      }, 30_000);
    }

    if (request.signal.aborted) { abort(); return; }

    // Covers both the HTTP upgrade and a connected peer that never sends hello.
    helloDeadline = setTimeout(() => fail('core_timeout', getSafeErrorMessage('core_timeout'), 504), 10_000);

    try {
      socket = new WebSocket(`${wsUrl}/v1/ws/chat`, {
        headers: { Authorization: `Bearer ${serviceKey}`, 'X-Neyra-Identity': identityJwt },
        handshakeTimeout: 10_000,
        maxPayload: 1024 * 1024,
      });
    } catch {
      fail('core_unavailable', getSafeErrorMessage('core_unavailable'));
      return;
    }

    socket.on('error', () => fail('core_unavailable', 'Соединение с ядром Нейры прервано. Попробуйте позже.'));
    socket.on('close', () => fail('core_disconnected', getSafeErrorMessage('core_disconnected')));

    socket.on('message', (data, isBinary) => {
      if (finished) return;
      let event: Record<string, unknown>;
      try {
        if (isBinary) throw new Error();
        event = JSON.parse(data.toString());
        if (!event || typeof event !== 'object') throw new Error();
      } catch {
        fail('core_protocol_error', getSafeErrorMessage('core_protocol_error'));
        return;
      }

      if (event.type === 'pong') {
        if (receivedHello) resetIdleTimer();
        return;
      }

      if (event.type === 'hello') {
        if (receivedHello) return;
        receivedHello = true;
        clearTimeout(helloDeadline);
        replied = true;

        resetIdleTimer();
        overallTimer = setTimeout(() => {
          fail('core_timeout', getSafeErrorMessage('core_timeout'), 504);
        }, 300_000);

        resolve(new Response(stream, { headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'X-Accel-Buffering': 'no',
        } }));

        try {
          socket!.send(JSON.stringify(payload), error => {
            if (error) fail('core_unavailable', getSafeErrorMessage('core_unavailable'));
          });
        } catch {
          fail('core_unavailable', getSafeErrorMessage('core_unavailable'));
        }
        return;
      }

      if (!receivedHello) {
        fail('core_protocol_error', 'Ядро Нейры не подтвердило готовность чата.');
        return;
      }

      resetIdleTimer();

      if (!['token', 'thinking', 'done', 'error'].includes(String(event.type))) return;

      if ((event.type === 'token' || event.type === 'done') && typeof event.text !== 'string') {
        fail('core_protocol_error', getSafeErrorMessage('core_protocol_error'));
        return;
      }

      if (event.type === 'token') {
        const sanitized = SseChatEventSchema.parse({
          type: 'token',
          text: String(event.text),
        });
        emitSanitized(sanitized);
      } else if (event.type === 'thinking') {
        const sanitized = SseChatEventSchema.parse({
          type: 'thinking',
          text: typeof event.text === 'string' ? event.text : '',
        });
        emitSanitized(sanitized);
      } else if (event.type === 'done') {
        const sanitized = SseChatEventSchema.parse({
          type: 'done',
          text: String(event.text),
        });
        emitSanitized(sanitized);
        finish();
      } else if (event.type === 'error') {
        const rawCode = typeof event.code === 'string' && event.code ? event.code : 'core_error';
        const safeMessage = getSafeErrorMessage(rawCode);
        const sanitized = SseChatEventSchema.parse({
          type: 'error',
          code: rawCode,
          message: safeMessage,
        });
        emitSanitized(sanitized);
        finish();
      }
    });

    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) abort();
  });
}
