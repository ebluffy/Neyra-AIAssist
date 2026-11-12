import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { getDatabase } from './db';
import { readAuthEnv } from './env';
import { MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH, roleField } from './auth-policy';
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
  });
}
let auth: ReturnType<typeof createAuth> | undefined;
export function getAuth() { return auth ??= createAuth(); }
