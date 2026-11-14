import { NextResponse } from 'next/server';
import { AttachmentSchema } from '@neyra/contracts';
import { getAuth } from '../../../../lib/auth';
import { readCoreEnv } from '../../../../lib/core-admin';
import { readChatEnv } from '../../../../lib/env';
import { createIdentityToken } from '../../../../lib/identity';
import { readBodyWithLimit } from '../../../../lib/request-body';
import {
  beginUpload,
  checkUploadRateLimit,
  endUpload,
  releaseUpload,
  reserveUpload,
} from '../../../../lib/upload-limits';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Лимиты ядра #73: не больше 4 файлов по 8 МБ. Сайт проверяет их до отправки,
// чтобы не гонять лишние мегабайты и не показывать «файл прикреплён» раньше времени.
const MAX_FILES = 4;
const MAX_FILE_SIZE = 8 * 1024 * 1024;
const MAX_TOTAL_SIZE = MAX_FILES * MAX_FILE_SIZE;
// Запас на multipart-заголовки и boundary.
const MAX_BODY_SIZE = MAX_TOTAL_SIZE + 64 * 1024;

function jsonError(status: number, error: string, message: string, headers?: HeadersInit): Response {
  return NextResponse.json({ error, message }, { status, headers });
}

function isUpload(value: unknown): value is File {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof (value as File).name === 'string' &&
    typeof (value as File).size === 'number' &&
    typeof (value as File).arrayBuffer === 'function',
  );
}

function attachmentEnv() {
  const core = readCoreEnv();
  if (!core) return null;
  try {
    const chat = readChatEnv();
    return { core, chat };
  } catch {
    return null;
  }
}

// Возможность загрузки без похода в ядро: UI честно показывает «скоро»,
// если на площадке не заданы адрес/ключ ядра или identity-пара.
export async function GET() {
  const env = attachmentEnv();
  return NextResponse.json({
    available: Boolean(env),
    ...(env ? {} : { message: 'Вложения пока недоступны: ядро или identity не настроены.' }),
  });
}

export async function POST(request: Request) {
  let session;
  try {
    session = await getAuth().api.getSession({ headers: request.headers });
  } catch {
    return jsonError(503, 'auth_unavailable', 'Сервис аутентификации временно недоступен.');
  }
  if (!session?.user) {
    return jsonError(401, 'unauthorized', 'Требуется авторизация для загрузки вложения.');
  }

  const env = attachmentEnv();
  if (!env) {
    return jsonError(503, 'attachments_unavailable', 'Вложения пока недоступны: ядро не подключено.');
  }

  // AR-26: без Content-Length тело нельзя оценить до чтения — не принимаем.
  const lengthHeader = request.headers.get('content-length');
  if (lengthHeader === null || !lengthHeader.trim()) {
    return jsonError(411, 'length_required', 'Нужен заголовок Content-Length.');
  }
  const declared = Number(lengthHeader);
  if (!Number.isInteger(declared) || declared <= 0) {
    return jsonError(400, 'invalid_content_length', 'Некорректный Content-Length.');
  }
  if (declared > MAX_BODY_SIZE) {
    return jsonError(413, 'attachment_size', 'Превышен лимит загрузки: не больше 4 файлов по 8 МБ.');
  }

  const rate = checkUploadRateLimit(session.user.id);
  if (!rate.ok) {
    return jsonError(429, 'rate_limited', 'Слишком много загрузок. Попробуйте позже.', {
      'Retry-After': String(rate.retryAfterSeconds ?? 60),
    });
  }
  if (!beginUpload(session.user.id)) {
    return jsonError(429, 'rate_limited', 'Слишком много одновременных загрузок. Дождитесь завершения.');
  }

  let reservationId: string | null = null;
  let committed = false;
  try {
    // Считаем фактические байты потоком: Content-Length может врать или отсутствовать
    // в промежуточном прокси, а буфер ограничен MAX_BODY_SIZE.
    const read = await readBodyWithLimit(request.body, MAX_BODY_SIZE);
    if (!read.ok) {
      return read.reason === 'too_large'
        ? jsonError(413, 'attachment_size', 'Превышен лимит загрузки: не больше 4 файлов по 8 МБ.')
        : jsonError(400, 'invalid_multipart', 'Тело запроса пустое.');
    }

    const contentType = request.headers.get('content-type') || '';
    if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
      return jsonError(415, 'invalid_multipart', 'Ожидалась multipart-форма с файлами.');
    }

    let form: FormData;
    try {
      form = await new Response(read.bytes as unknown as BodyInit, { headers: { 'content-type': contentType } }).formData();
    } catch {
      return jsonError(400, 'invalid_multipart', 'Ожидалась multipart-форма с файлами.');
    }

    const rawChatId = form.get('chat_id');
    const chatId = typeof rawChatId === 'string' ? rawChatId.trim() : '';
    if (!chatId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(chatId)) {
      return jsonError(400, 'invalid_chat_id', 'Некорректный идентификатор диалога.');
    }

    const files = form.getAll('files').filter(isUpload);
    if (files.length < 1 || files.length > MAX_FILES) {
      return jsonError(400, 'attachment_count', `Можно прикрепить от 1 до ${MAX_FILES} файлов.`);
    }
    let total = 0;
    for (const file of files) {
      if (!file.size) return jsonError(422, 'invalid_attachment', 'Файл пуст.');
      if (file.size > MAX_FILE_SIZE) {
        return jsonError(413, 'attachment_size', `Файл «${file.name}» больше 8 МБ.`);
      }
      total += file.size;
    }
    if (total > MAX_TOTAL_SIZE) {
      return jsonError(413, 'attachment_size', 'Суммарный размер файлов больше 32 МБ.');
    }

    // Квота на 24 часа: резервируем атомарно до похода в ядро, чтобы две
    // параллельные загрузки не прошли проверку на одном свободном месте.
    const reservation = reserveUpload(session.user.id, total);
    if (!reservation.ok || !reservation.reservation) {
      return jsonError(429, 'upload_quota', 'Квота вложений на 24 часа исчерпана. Попробуйте позже.', {
        'Retry-After': String(reservation.retryAfterSeconds ?? 3600),
      });
    }
    reservationId = reservation.reservation.id;

    // Канал тот же, что у чата: web:<user.id>:<chat_id>. Клиент не может подставить чужой.
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
        env.chat.jwtSecret,
        { chat_id: channelId, task: 'attachment', issuer: env.chat.jwtIssuer },
      );
    } catch {
      return jsonError(500, 'identity_error', 'Не удалось сформировать токен идентичности.');
    }

    const upstream = new FormData();
    upstream.set('channel_id', channelId);
    for (const file of files) upstream.append('files', file, file.name);

    let coreResponse: Response;
    try {
      coreResponse = await fetch(`${env.core.url}/v1/attachments`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.core.token}`,
          'X-Neyra-Identity': identityJwt,
          accept: 'application/json',
        },
        body: upstream,
        signal: AbortSignal.timeout(30_000),
        cache: 'no-store',
      });
    } catch {
      return jsonError(503, 'attachments_unavailable', 'Сервис вложений временно недоступен. Попробуйте позже.');
    }

    const payload = await coreResponse.json().catch(() => null) as {
      ok?: boolean;
      data?: { attachments?: unknown };
      error?: { code?: string; message?: string } | string;
      detail?: unknown;
    } | null;

    if (!coreResponse.ok) {
      if (coreResponse.status === 404 || coreResponse.status === 503) {
        return jsonError(503, 'attachments_unavailable', 'Ядро не поддерживает вложения. Обновите ядро.');
      }
      const upstreamMessage = payload && typeof payload === 'object' && payload.error && typeof payload.error === 'object'
        ? payload.error.message
        : undefined;
      const upstreamCode = payload && typeof payload === 'object' && payload.error && typeof payload.error === 'object'
        ? payload.error.code
        : undefined;
      const status = [400, 413, 415, 422].includes(coreResponse.status) ? coreResponse.status : 502;
      return jsonError(
        status,
        upstreamCode || 'attachment_rejected',
        upstreamMessage || 'Ядро не приняло вложение.',
      );
    }

    const raw = payload?.data?.attachments;
    if (!Array.isArray(raw)) {
      return jsonError(502, 'attachment_contract', 'Ядро вернуло неожиданный ответ по вложениям.');
    }
    const attachments = [];
    for (const item of raw) {
      const parsed = AttachmentSchema.safeParse(item);
      if (!parsed.success) {
        return jsonError(502, 'attachment_contract', 'Ядро вернуло вложение в неизвестном формате.');
      }
      attachments.push(parsed.data);
    }
    if (attachments.length !== files.length) {
      return jsonError(502, 'attachment_contract', 'Ядро сохранило не все вложения.');
    }

    // Успех: резерв становится фактическим расходом квоты.
    committed = true;
    return NextResponse.json({ attachments });
  } finally {
    if (reservationId && !committed) releaseUpload(session.user.id, reservationId);
    endUpload(session.user.id);
  }
}
