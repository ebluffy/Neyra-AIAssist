import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { BASE_ERROR_CODES } from '@better-auth/core/error';
import { getDatabase } from './db';
import { readAuthEnv } from './env';
import { MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH, roleField } from './auth-policy';
import {
  FAILED_LOGIN_MAX_ATTEMPTS,
  clearFailures,
  clientIp,
  noteFailure,
  readEmail,
  readFailures,
} from './login-throttle';
import { checkInvite, consumeInvite, readInviteToken, releaseInvite } from './invite';
import { isUserBanned, touchLastLogin } from './admin-users';
import * as schema from '../db/schema';

// Ссылка сброса пароля живёт до первого запроса админа (2 минуты): письма сайт
// не отправляет, админ передаёт одноразовую ссылку сам.
const pendingResets = new Map<string, { url: string; at: number }>();
const RESET_LINK_TTL_MS = 2 * 60 * 1000;

export function takeResetLink(email: string): string | null {
  const key = email.trim().toLowerCase();
  const entry = pendingResets.get(key);
  pendingResets.delete(key);
  if (!entry) return null;
  if (Date.now() - entry.at > RESET_LINK_TTL_MS) return null;
  return entry.url;
}

function createAuth() {
  const env = readAuthEnv();
  return betterAuth({
    secret: env.secret,
    baseURL: env.baseURL,
    database: drizzleAdapter(getDatabase().db, { provider: 'pg', schema }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      maxPasswordLength: MAX_PASSWORD_LENGTH,
      // Сброс пароля инициирует админ из панели: письмо не отправляется, ссылка
      // возвращается ему один раз и передаётся пользователю вручную.
      resetPasswordTokenExpiresIn: 60 * 60,
      sendResetPassword: async ({ user: target, url }) => {
        if (pendingResets.size > 100) pendingResets.clear();
        pendingResets.set(target.email.trim().toLowerCase(), { url, at: Date.now() });
      },
    },
    user: { additionalFields: { role: roleField } },
    // AR-28: бан останавливает выдачу сессии уже после проверки пароля, поэтому
    // ответ забаненному неотличим от ответа на неверный пароль ни телом, ни
    // временем. Хук срабатывает и для email/пароля, и для OAuth-входа.
    databaseHooks: {
      session: {
        create: {
          before: async (data) => {
            if (await isUserBanned(String(data.userId))) {
              throw APIError.from('UNAUTHORIZED', BASE_ERROR_CODES.INVALID_EMAIL_OR_PASSWORD);
            }
            return true;
          },
        },
      },
    },
    // No automatic promotion on sign-up: an e-mail is not proof of ownership, and an open
    // registration would let a stranger claim a listed admin address. The first admin is
    // granted from the server with scripts/grant-admin.mjs.
    session: { expiresIn: 60 * 60 * 24 * 30 },
    // nginx/frp bring all requests from 127.0.0.1; the real client address arrives
    // in x-real-ip set by the edge proxy, so only that header is trusted for limits.
    // 5 attempts per minute per IP on credential endpoints, on top of the per-account
    // failed-login counter below.
    rateLimit: {
      enabled: true,
      window: 10,
      max: 100,
      customRules: {
        '/sign-in/email': { window: 60, max: 5 },
        '/sign-up/email': { window: 60, max: 5 },
      },
    },
    advanced: {
      ipAddress: { ipAddressHeaders: ['x-real-ip'] },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (!ctx.request) return;
        if (ctx.path === '/sign-in/email') {
          // Block the N+1 failed attempt for the same account even from another address.
          const email = await readEmail(ctx.request);
          if (!email) return;
          signInEmail.set(ctx.request, email);
          const ip = clientIp(ctx.request);
          signInIp.set(ctx.request, ip);
          // AR-28: бан проверяется не здесь. Ранний возврат отвечает без
          // проверки пароля, то есть заметно быстрее настоящей ошибки Better
          // Auth (scrypt), и по времени видно и адрес, и блокировку. Бан
          // блокирует создание сессии в databaseHooks.session.create.before.
          if ((await readFailures(email, ip)) >= FAILED_LOGIN_MAX_ATTEMPTS) {
            return ctx.json(
              { message: 'Слишком много неудачных попыток входа. Попробуйте позже.' },
              { status: 429 },
            );
          }
          return;
        }
        if (ctx.path === '/sign-up/email') {
          // AR-2: регистрация только по одноразовому инвайту. Проверка на сервере,
          // до обработки better-auth: без инвайта, с чужим, потраченным или
          // просроченным аккаунт не создаётся.
          let body: unknown = null;
          try { body = await ctx.request.clone().json(); } catch { /* не JSON — endpoint сам ответит 400 */ }
          const email = (body as { email?: unknown } | null)?.email;
          const inviteToken = readInviteToken(body);
          if (typeof email === 'string' && email.trim()) {
            signUpInvite.set(ctx.request, { invite: inviteToken ?? '', email: email.trim().toLowerCase() });
          }
          if (!inviteToken) {
            return ctx.json({ message: 'Регистрация на сайте — только по инвайту. Обратитесь к администратору Нейры.' }, { status: 403 });
          }
          const verdict = await checkInvite(inviteToken);
          if (verdict !== 'ok') {
            const message = verdict === 'error'
              ? 'Не удалось проверить инвайт. Попробуйте позже.'
              : 'Инвайт недействителен, уже использован или истёк. Запросите новый.';
            return ctx.json({ message }, { status: 403 });
          }
          // AR-26: инвайт тратится атомарно ДО создания аккаунта; проигравшая
          // параллельная регистрация получает 403. При ошибке after вернёт его.
          const consumed = await consumeInvite(inviteToken, typeof email === 'string' ? email.trim().toLowerCase() : '');
          if (!consumed) {
            return ctx.json(
              { message: 'Инвайт недействителен, уже использован или истёк. Запросите новый.' },
              { status: 403 },
            );
          }
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (!ctx.request) return;
        const returned = (ctx.context as { returned?: unknown }).returned;
        const statusCode = returned && typeof returned === 'object' && 'statusCode' in returned
          ? (returned as { statusCode?: number }).statusCode
          : undefined;
        if (ctx.path === '/sign-in/email') {
          // Count failures, reset on success. On error `returned` is the APIError
          // thrown by the endpoint (has statusCode); on success it is the body object.
          const email = signInEmail.get(ctx.request);
          const ip = signInIp.get(ctx.request) ?? 'unknown';
          signInEmail.delete(ctx.request);
          signInIp.delete(ctx.request);
          if (!email) return;
          if (statusCode === 429) return; // already throttled; do not stack counters
          if (statusCode === undefined) {
            await clearFailures(email, ip); // success body
            await touchLastLogin(email);
          } else if (statusCode === 401) await noteFailure(email, ip);
          return;
        }
        if (ctx.path === '/sign-up/email') {
          // Инвайт уже потрачен в before; неудачная регистрация возвращает его.
          const pending = signUpInvite.get(ctx.request);
          signUpInvite.delete(ctx.request);
          if (!pending?.invite) return;
          if (statusCode !== undefined) await releaseInvite(pending.invite);
        }
      }),
    },
  });
}
let auth: ReturnType<typeof createAuth> | undefined;
export function getAuth() { return auth ??= createAuth(); }

// Email from the request body is captured in the before hook: by the after hook
// the body stream is already consumed by the endpoint, so it is carried per-request.
const signInEmail = new WeakMap<Request, string>();
// IP запроса для счётчика неудач (email + IP), см. AR-27.
const signInIp = new WeakMap<Request, string>();
// Same idea for invite-only sign-up: invite token and email ride the request object.
const signUpInvite = new WeakMap<Request, { invite: string; email: string }>();
