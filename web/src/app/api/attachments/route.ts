import { NextResponse } from 'next/server';
import { AttachmentSchema } from '@neyra/contracts';
import { getAuth } from '../../../../lib/auth';
import { readCoreEnv } from '../../../../lib/core-admin';
import { readChatEnv } from '../../../../lib/env';
import { createIdentityToken } from '../../../../lib/identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Лимиты ядра #73: не больше 4 файлов по 8 МБ. Сайт проверяет их до отправки,
// чтобы не гонять лишние мегабайты и не показывать «файл прикреплён» раньше времени.
const MAX_FILES = 4;
const MAX_FILE_SIZE = 8 * 1024 * 1024;
const MAX_TOTAL_SIZE = MAX_FILES * MAX_FILE_SIZE;

function jsonError(status: number, error: string, message: string): Response {
  return NextResponse.json({ error, message }, { status });
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

  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_TOTAL_SIZE + 64 * 1024) {
    return jsonError(413, 'attachment_size', 'Превышен лимит загрузки: не больше 4 файлов по 8 МБ.');
  }

  let form: FormData;
  try {
    form = await request.formData();
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

  return NextResponse.json({ attachments });
}
