import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { getDatabase } from './db';
import { readAuthEnv } from './env';
import { MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH, readAdminEmails, resolveRole, roleField } from './auth-policy';
import * as schema from '../db/schema';
function createAuth() {
  const env = readAuthEnv();
  return betterAuth({
    secret: env.secret,
    baseURL: env.baseURL,
    database: drizzleAdapter(getDatabase().db, { provider: 'pg', schema }),
    emailAndPassword: { enabled: true, minPasswordLength: MIN_PASSWORD_LENGTH, maxPasswordLength: MAX_PASSWORD_LENGTH },
    user: { additionalFields: { role: roleField } },
    databaseHooks: {
      user: {
        create: {
          // The role is set by the server from ADMIN_EMAILS, never from the sign-up payload.
          before: async (newUser) => ({
            data: { ...newUser, role: resolveRole(String(newUser.email ?? ''), readAdminEmails(process.env.ADMIN_EMAILS)) },
          }),
        },
      },
    },
    session: { expiresIn: 60 * 60 * 24 * 30 },
  });
}
let auth: ReturnType<typeof createAuth> | undefined;
export function getAuth() { return auth ??= createAuth(); }
