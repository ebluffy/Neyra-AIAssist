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
import * as schema from '../db/schema';

function createAuth() {
  const env = readAuthEnv();
  return betterAuth({
    secret: env.secret,
    baseURL: env.baseURL,
    database: drizzleAdapter(getDatabase().db, { provider: 'pg', schema }),
    emailAndPassword: { enabled: true, minPasswordLength: MIN_PASSWORD_LENGTH, maxPasswordLength: MAX_PASSWORD_LENGTH },
    user: { additionalFields: { role: roleField } },
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
      // Block the N+1 failed attempt for the same account even from another address.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== '/sign-in/email' || !ctx.request) return;
        const email = await readEmail(ctx.request);
        if (!email) return;
        signInEmail.set(ctx.request, email);
        if ((await readFailures(email)) >= FAILED_LOGIN_MAX_ATTEMPTS) {
          return ctx.json(
            { message: 'Слишком много неудачных попыток входа. Попробуйте позже.' },
            { status: 429 },
          );
        }
      }),
      // Count failures, reset on success. On error `returned` is the APIError
      // thrown by the endpoint (has statusCode); on success it is the body object.
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== '/sign-in/email' || !ctx.request) return;
        const email = signInEmail.get(ctx.request);
        signInEmail.delete(ctx.request);
        if (!email) return;
        const returned = (ctx.context as { returned?: unknown }).returned;
        const statusCode = returned && typeof returned === 'object' && 'statusCode' in returned
          ? (returned as { statusCode?: number }).statusCode
          : undefined;
        if (statusCode === 429) return; // already throttled; do not stack counters
        if (statusCode === undefined) await clearFailures(email); // success body
        else if (statusCode === 401) await noteFailure(email);
      }),
    },
  });
}
let auth: ReturnType<typeof createAuth> | undefined;
export function getAuth() { return auth ??= createAuth(); }

// Email from the request body is captured in the before hook: by the after hook
// the body stream is already consumed by the endpoint, so it is carried per-request.
const signInEmail = new WeakMap<Request, string>();
