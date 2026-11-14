import { SignJWT, jwtVerify } from 'jose';

export interface IdentityUser {
  id: string;
  role?: string | null;
  name?: string | null;
  email?: string | null;
}

export interface IdentityOptions {
  chat_id?: string;
  message_id?: string;
  task?: string;
  now?: number;
  issuer?: string;
}

export interface IdentityClaims {
  iss: string;
  sub: string;
  role: string;
  name: string;
  chat_id: string;
  message_id: string;
  task: string;
  iat: number;
  exp: number;
  [key: string]: unknown;
}

/**
 * Собирает claims идентичности пользователя для запросов к ядру Neyra.
 * Спецификация: docs/ru/architecture/web-v2.md §8.
 * Claims: iss, sub, role, name, chat_id, message_id, task, iat, exp (TTL = 60с).
 */
export function buildIdentityClaims(
  user: IdentityUser,
  options: IdentityOptions = {}
): IdentityClaims {
  if (!user || !user.id) {
    throw new Error('Пользователь и его идентификатор (sub) обязательны для создания идентичности.');
  }
  const issuer = (options.issuer ?? process.env.NEYRA_IDENTITY_JWT_ISSUER ?? '').trim();
  if (!issuer) {
    throw new Error('Идентификатор эмитента NEYRA_IDENTITY_JWT_ISSUER обязателен.');
  }
  const now = options.now ?? Math.floor(Date.now() / 1000);
  return {
    iss: issuer,
    sub: user.id,
    role: user.role ?? 'user',
    name: user.name ?? user.email ?? user.id,
    chat_id: options.chat_id ?? crypto.randomUUID(),
    message_id: options.message_id ?? crypto.randomUUID(),
    task: options.task ?? 'chat',
    iat: now,
    exp: now + 60,
  };
}

/**
 * Подписывает claims алгоритмом HS256 с использованием секрета NEYRA_IDENTITY_JWT_SECRET.
 */
export async function signIdentityJwt(claims: IdentityClaims, secret?: string): Promise<string> {
  const keySecret = secret ?? process.env.NEYRA_IDENTITY_JWT_SECRET;
  if (!keySecret) {
    throw new Error('Секрет NEYRA_IDENTITY_JWT_SECRET не задан.');
  }
  const key = new TextEncoder().encode(keySecret);
  return await new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'HS256' })
    .sign(key);
}

/**
 * Формирует claims и подписывает identity-JWT за один вызов.
 */
export async function createIdentityToken(
  user: IdentityUser,
  secret?: string,
  options?: IdentityOptions
): Promise<string> {
  const claims = buildIdentityClaims(user, options);
  return signIdentityJwt(claims, secret);
}

/**
 * Проверяет подпись и валидность токена идентичности.
 */
export async function verifyIdentityToken(
  token: string,
  secret: string,
  options?: { issuer?: string; currentDate?: Date }
) {
  const key = new TextEncoder().encode(secret);
  const issuer = options?.issuer ?? process.env.NEYRA_IDENTITY_JWT_ISSUER;
  return await jwtVerify(token, key, {
    algorithms: ['HS256'],
    issuer: issuer || undefined,
    currentDate: options?.currentDate,
  });
}
