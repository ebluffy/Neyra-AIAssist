import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { createAuthMiddleware } from 'better-auth/api';
import { getDatabase } from './db';
import { readAuthEnv } from './env';
import { MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH, roleField } from './auth-policy';
import {
  FAILED_LOGIN_MAX_ATTEMPTS,
  clearFailures,
  noteFailure,
  readEmail,
  readFailures,
} from './login-throttle';
import { checkInvite, consumeInvite, readInviteToken } from './invite';
import { findBannedByEmail, touchLastLogin } from './admin-users';
import { getRegistrationMode } from './site-settings';
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

// Discord OAuth: ключи приходят из env стенда. Если их нет — провайдер не включается
// вовсе, чтобы кнопка на входе не вела в никуда.
function discordProvider() {
  const clientId = process.env.DISCORD_CLIENT_ID?.trim();
  const clientSecret = process.env.DISCORD_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return {};
  return {
    discord: {
      clientId,
      clientSecret,
      scope: ['identify', 'email'],
      // Сайт закрыт инвайтами: через Discord пускаем только тех, кто уже заведён
      // (совпадение email привяжет аккаунт). При открытой регистрации вход создаёт профиль.
      disableImplicitSignUp: process.env.INVITE_REQUIRED === 'true',
      // Discord отдаёт email: null для аккаунтов, заведённых только по телефону.
      // Заглушка не адрес для писем, а стабильный идентификатор внутри .invalid.
      mapProfileToUser: (profile: { id: string; email?: string | null }) => ({
        email: profile.email ?? `${profile.id}@discord.placeholder.invalid`,
      }),
    },
  };
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
    socialProviders: discordProvider(),
    // Discord считаем доверенным провайдером: при совпадении подтверждённого email
    // вход привязывается к существующему профилю, а не создаёт второй.
    account: { accountLinking: { enabled: true, trustedProviders: ['discord'] } },
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
          // Блокировка админом действует и на новый вход, даже если старые сессии уже удалены.
          const state = await findBannedByEmail(email).catch(() => null);
          if (state?.banned) {
            return ctx.json({ message: 'Аккаунт заблокирован администратором Нейры.' }, { status: 403 });
          }
          if ((await readFailures(email)) >= FAILED_LOGIN_MAX_ATTEMPTS) {
            return ctx.json(
              { message: 'Слишком много неудачных попыток входа. Попробуйте позже.' },
              { status: 429 },
            );
          }
          return;
        }
        if (ctx.path === '/sign-up/email') {
          // Режим регистрации задаёт админ в site_setting: invite | open | closed.
          // При недоступной БД getRegistrationMode не бросает и отдаёт безопасный
          // fallback (env INVITE_REQUIRED, иначе invite).
          const mode = await getRegistrationMode();
          if (mode === 'closed') {
            return ctx.json({ message: 'Регистрация закрыта администратором Нейры.' }, { status: 403 });
          }
          if (mode === 'open') {
            // Открытая регистрация: инвайт не требуется и не расходуется.
            return;
          }
          // AR-2: режим invite — одноразовый токен. Проверка на сервере,
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
          signInEmail.delete(ctx.request);
          if (!email) return;
          if (statusCode === 429) return; // already throttled; do not stack counters
          if (statusCode === undefined) {
            await clearFailures(email); // success body
            await touchLastLogin(email);
          } else if (statusCode === 401) await noteFailure(email);
          return;
        }
        if (ctx.path === '/sign-up/email') {
          // Успешная регистрация тратит инвайт атомарно (used_by/used_at).
          const pending = signUpInvite.get(ctx.request);
          signUpInvite.delete(ctx.request);
          if (!pending?.invite) return;
          if (statusCode !== undefined) return; // регистрация не прошла — инвайт не тратим
          await consumeInvite(pending.invite, pending.email);
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
// Same idea for invite-only sign-up: invite token and email ride the request object.
const signUpInvite = new WeakMap<Request, { invite: string; email: string }>();
