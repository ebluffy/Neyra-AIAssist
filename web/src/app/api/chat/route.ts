import { NextResponse } from 'next/server';

// Ensure pure JS fallback for ws in standalone builds to prevent TypeError: b.mask is not a function
if (!process.env.WS_NO_BUFFER_UTIL) process.env.WS_NO_BUFFER_UTIL = '1';
if (!process.env.WS_NO_UTF_8_VALIDATE) process.env.WS_NO_UTF_8_VALIDATE = '1';

import WebSocket from 'ws';
import { ChatRequestSchema, ContextUsageSchema, SseChatEventSchema, TurnStatsSchema, type SseChatEvent } from '@neyra/contracts';
import { getAuth } from '../../../../lib/auth';
import { readChatEnv } from '../../../../lib/env';
import { createIdentityToken } from '../../../../lib/identity';
import { getLinkedDiscordId } from '../../../../lib/discord-account';
import { appendMessage, ensureConversation, messageExists, upsertMessage } from '../../../../lib/chat-store';
import {
  beginChatStream,
  checkChatRateLimit,
  endChatStream,
} from '../../../../lib/chat-limits';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HISTORY_WRITE_TIMEOUT_MS = 5_000;

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
  provider_rate_limit: 'Провайдер моделей ограничил запросы. Попробуйте позже — лимит сбрасывается автоматически.',
  idle_timeout: 'Превышено время ожидания ответа ядра.',
};

// Только эти коды ядра несут публичный текст, который можно показать как есть.
// Для остальных сообщение ядра может содержать внутренние детали — заменяем.
const USER_FACING_CORE_CODES = new Set(['provider_rate_limit', 'brain_unavailable']);

function getSafeErrorMessage(code: string): string {
  return SAFE_ERROR_MESSAGES[code] || 'Ошибка при обработке сообщения в ядре.';
}

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

  const limit = checkChatRateLimit(session.user.id);
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'rate_limited', message: SAFE_ERROR_MESSAGES.rate_limited },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds ?? 60) } }
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
  const { wsUrl, webKey, jwtSecret, jwtIssuer } = env;
  if (!webKey) {
    return NextResponse.json(
      { error: 'configuration_error', message: 'Не задан NEYRA_WEB_KEY — ключ web-роли ядра (API_WEB_TOKEN).' },
      { status: 500 }
    );
  }
  if (!jwtSecret || !jwtIssuer) {
    return NextResponse.json(
      { error: 'configuration_error', message: 'Не настроена конфигурация ядра или ключи идентичности.' },
      { status: 500 }
    );
  }

  const chatId = parsed.data.chat_id ?? crypto.randomUUID();
  const channelId = `web:${session.user.id}:${chatId}`;

  let identityJwt: string;
  try {
    const discordId = await getLinkedDiscordId(request.headers);

    identityJwt = await createIdentityToken(
      {
        id: session.user.id,
        role: session.user.role,
        name: session.user.name,
        email: session.user.email,
        discord_id: discordId,
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

  const historyModel = parsed.data.model?.slice(0, 200);

  const payload = {
    type: 'chat',
    text,
    username: session.user.email,
    platform_user_id: session.user.id,
    channel_id: channelId,
    ...(historyModel ? { model: historyModel } : {}),
    ...(parsed.data.deep_think ? { deep_think: true } : {}),
    ...(parsed.data.attachments?.length ? { attachments: parsed.data.attachments } : {}),
  };

  const userId = session.user.id;
  if (!beginChatStream(userId)) {
    return NextResponse.json(
      { error: 'rate_limited', message: 'Слишком много одновременных ответов. Дождитесь завершения текущего.' },
      { status: 429 }
    );
  }

  const historyUserId = session.user.id;
  const historyAttachments = parsed.data.attachments ?? null;
  const historyUserMessageId = parsed.data.user_message_id;
  const historyAssistantMessageId = parsed.data.assistant_message_id;
  const historyRetry = parsed.data.retry === true;
  let historyReady = false;

  return new Promise<Response>((resolve) => {
    let socket: WebSocket | undefined;
    let output: ReadableStreamDefaultController<Uint8Array>;
    let finished = false;
    let terminal = false;
    let replied = false;
    let receivedHello = false;
    let cancelled = false;
    let assistantSettled = false;
    let assistantSaved = false;
    let pendingSettle: { content: string; status: string; errorCode?: string } | null = null;
    let streamedText = '';
    let endReason: { status: 'stopped' | 'error'; code?: string } | undefined;
    let helloDeadline: ReturnType<typeof setTimeout> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let overallTimer: ReturnType<typeof setTimeout> | undefined;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { output = controller; },
      cancel() {
        cancelled = true;
        endReason = { status: 'stopped' };
        finish(true);
      },
    });

    function finish(force = false) {
      if (finished) return;
      if (endReason) settleAssistant('', endReason.status, endReason.code);
      finished = true;
      endChatStream(userId);
      clearTimeout(helloDeadline);
      clearTimeout(idleTimer);
      clearTimeout(overallTimer);
      request.signal.removeEventListener('abort', abort);
      try {
        output.close();
      } catch {
        // already cancelled by the client
      }
      if (socket) {
        if (force || socket.readyState === WebSocket.CONNECTING) socket.terminate();
        else if (socket.readyState === WebSocket.OPEN) socket.close(1000);
      }
    }

    function emitSanitized(event: SseChatEvent) {
      try {
        output.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      } catch {
        // Клиент уже закрыл поток: ответ всё равно записан в историю.
      }
    }

    async function settleAssistant(
      content: string,
      status: string,
      errorCode?: string,
    ): Promise<boolean> {
      if (!historyReady) {
        // Ответ может прийти раньше, чем закончится запись вопроса.
        pendingSettle = { content, status, ...(errorCode ? { errorCode } : {}) };
        return false;
      }
      if (assistantSettled) return assistantSaved;
      const finalContent = content.trim() || streamedText.trim() || '(ответ не завершён)';
      assistantSettled = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // Зависшая запись не должна держать SSE и слот лимита: клиент получит
        // history_saved=false, а ход останется в локальном кэше.
        await Promise.race([
          upsertMessage(historyUserId, chatId, {
            id: historyAssistantMessageId,
            role: 'assistant',
            content: finalContent,
            model: historyModel,
            status,
            errorCode: errorCode ?? null,
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('history_write_timeout')),
              HISTORY_WRITE_TIMEOUT_MS,
            );
          }),
        ]);
        assistantSaved = true;
      } catch {
        assistantSaved = false;
      } finally {
        if (timer) clearTimeout(timer);
      }
      return assistantSaved;
    }

    function fail(code: string, message: string, status = 502) {
      if (finished || terminal) return;
      endReason = { status: 'error', code };
      if (replied) {
        settleAssistant('', 'error', code);
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
      cancelled = true;
      endReason = { status: 'stopped' };
      if (replied) settleAssistant('', 'stopped');
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
        headers: { Authorization: `Bearer ${webKey}`, 'X-Neyra-Identity': identityJwt },
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

        void (async () => {
          if (!cancelled) {
            try {
              await ensureConversation(historyUserId, chatId, text, historyModel);
              // Retry пишет вопрос только если его действительно нет в истории;
              // ответ обновляется на месте (upsert), поэтому порядок не ломается.
              const shouldWriteUser = !historyRetry
                || !(await messageExists(historyUserId, chatId, historyUserMessageId!));
              if (shouldWriteUser) {
                await appendMessage(historyUserId, chatId, {
                  id: historyUserMessageId,
                  role: 'user',
                  content: text,
                  model: historyModel,
                  attachments: historyAttachments,
                });
              }
              historyReady = true;
            } catch {
              console.warn('chat_history_write_failed');
            }
            if (pendingSettle) {
              const queued = pendingSettle;
              pendingSettle = null;
              settleAssistant(queued.content, queued.status, queued.errorCode);
            }
            if (endReason) settleAssistant('', endReason.status, endReason.code);
          }
          if (finished) return;
          try {
            socket!.send(JSON.stringify(payload), error => {
              if (error) fail('core_unavailable', getSafeErrorMessage('core_unavailable'));
            });
          } catch {
            fail('core_unavailable', getSafeErrorMessage('core_unavailable'));
          }
        })();
        return;
      }

      if (!receivedHello) {
        fail('core_protocol_error', 'Ядро Нейры не подтвердило готовность чата.');
        return;
      }

      resetIdleTimer();

      if (finished || terminal) return;
      if (!['token', 'thinking', 'phase', 'done', 'error'].includes(String(event.type))) return;

      if ((event.type === 'token' || event.type === 'done') && typeof event.text !== 'string') {
        fail('core_protocol_error', getSafeErrorMessage('core_protocol_error'));
        return;
      }

      if (event.type === 'phase') {
        if (typeof event.phase !== 'string' || !event.phase.trim()) return;
        const label = typeof event.label === 'string' && event.label.trim()
          ? event.label.trim().slice(0, 120)
          : undefined;
        const sanitized = SseChatEventSchema.parse({
          type: 'phase',
          phase: event.phase.trim().slice(0, 40),
          ...(label ? { label } : {}),
        });
        emitSanitized(sanitized);
      } else if (event.type === 'token') {
        streamedText += String(event.text);
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
        terminal = true;
        const usage = ContextUsageSchema.safeParse(event.usage);
        const turnStats = TurnStatsSchema.safeParse(event.turn_stats);
        const doneText = String(event.text);
        void settleAssistant(doneText.trim() || '(пустой ответ)', 'done').then((saved) => {
          const sanitized = SseChatEventSchema.parse({
            type: 'done',
            text: doneText,
            ...(usage.success ? { usage: usage.data } : {}),
            ...(turnStats.success ? { turn_stats: turnStats.data } : {}),
            history_saved: saved,
          });
          emitSanitized(sanitized);
          finish();
        });
      } else if (event.type === 'error') {
        terminal = true;
        const rawCode = typeof event.code === 'string' && event.code ? event.code : 'core_error';
        // Ядро уже отдаёт публичную причину (например, лимит провайдера). Не заменяем
        // её общим текстом; общий — только когда причина не пришла.
        const coreMessage = typeof event.message === 'string' ? event.message.trim().slice(0, 500) : '';
        const safeMessage = USER_FACING_CORE_CODES.has(rawCode) && coreMessage
          ? coreMessage
          : getSafeErrorMessage(rawCode);
        void settleAssistant('', 'error', rawCode).then((saved) => {
          const sanitized = SseChatEventSchema.parse({
            type: 'error',
            code: rawCode,
            message: safeMessage,
            history_saved: saved,
          });
          emitSanitized(sanitized);
          finish();
        });
      }
    });

    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) abort();
  });
}
