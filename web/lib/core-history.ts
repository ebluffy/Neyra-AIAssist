import { NextResponse } from 'next/server';
import { getAuth } from './auth';
import { readChatEnv } from './env';
import { createIdentityToken } from './identity';

export interface ProxyOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  timeoutMs?: number;
}

const CORE_ERROR_MESSAGES: Record<string, string> = {
  not_found: 'Ресурс не найден.',
  thread_not_found: 'Тред не найден.',
  note_not_found: 'Заметка не найдена.',
  message_not_found: 'Сообщение не найдено.',
  web_identity_required: 'Требуется авторизация пользователя.',
  invalid_web_identity: 'Недействительный токен пользователя.',
  memory_hub_unavailable: 'Хранилище истории временно недоступно.',
};

export async function proxyHistoryRequest(
  request: Request,
  corePath: string,
  options: ProxyOptions = {}
): Promise<Response> {
  // 1. Session check
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
      { error: 'unauthorized', message: 'Требуется авторизация.' },
      { status: 401 }
    );
  }

  // 2. Read environment configuration
  let env;
  try {
    env = readChatEnv();
  } catch {
    return NextResponse.json(
      { error: 'configuration_error', message: 'Некорректная конфигурация сервиса.' },
      { status: 500 }
    );
  }

  const { wsUrl, serviceKey, jwtSecret, jwtIssuer } = env;
  const coreApiUrl = (process.env.NEYRA_API_URL || (wsUrl ? wsUrl.replace(/^ws/, 'http') : 'http://127.0.0.1:8000')).replace(/\/+$/, '');

  // 3. Form identity token
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
      { task: 'history', issuer: jwtIssuer }
    );
  } catch {
    return NextResponse.json(
      { error: 'identity_error', message: 'Не удалось сформировать токен идентичности.' },
      { status: 500 }
    );
  }

  // 4. Query string construction
  const queryParams = new URLSearchParams();
  if (options.query) {
    for (const [k, v] of Object.entries(options.query)) {
      if (v !== undefined && v !== null && v !== '') {
        queryParams.set(k, String(v));
      }
    }
  }
  const queryString = queryParams.toString();
  const url = `${coreApiUrl}${corePath}${queryString ? `?${queryString}` : ''}`;

  // 5. Proxy call to core
  try {
    const coreRes = await fetch(url, {
      method: options.method || 'GET',
      headers: {
        authorization: `Bearer ${serviceKey}`,
        'x-neyra-identity': identityJwt,
        accept: 'application/json',
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(options.timeoutMs ?? 10000),
      cache: 'no-store',
    });

    const data = await coreRes.json().catch(() => null);

    if (!coreRes.ok) {
      const status = coreRes.status;
      const errorCode = data?.error || (status === 404 ? 'not_found' : 'core_error');
      const safeMessage =
        data?.message ||
        CORE_ERROR_MESSAGES[errorCode] ||
        (status === 404 ? 'Ресурс не найден.' : 'Ошибка при обращении к сервису истории.');
      return NextResponse.json(
        { error: errorCode, message: safeMessage, ok: false },
        { status }
      );
    }

    return NextResponse.json(data ?? { ok: true });
  } catch {
    return NextResponse.json(
      { error: 'core_unavailable', message: 'Сервис истории временно недоступен.' },
      { status: 502 }
    );
  }
}
