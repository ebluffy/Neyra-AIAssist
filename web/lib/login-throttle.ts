import { eq } from 'drizzle-orm';
import { getDatabase } from './db';
import { verification } from '../db/schema';

// Per-account brake for failed email/password sign-ins, on top of the IP rate limit.
// Stored in the existing verification key-value table (identifier/value/expiresAt),
// so no extra table is needed and rows expire on their own.
export const FAILED_LOGIN_MAX_ATTEMPTS = 5;
export const FAILED_LOGIN_WINDOW_MS = 15 * 60 * 1000;

const KEY_PREFIX = 'login-fail:';

// AR-27: счётчик привязан к паре email+IP, иначе чужой человек блокирует
// владельца аккаунта, зная только его адрес.
export function failedLoginKey(email: string, ip: string = 'unknown'): string {
  return `${KEY_PREFIX}${email.trim().toLowerCase()}:${(ip || '').trim() || 'unknown'}`;
}

// Только доверенный заголовок края (nginx/frp), как в better-auth rate limit.
export function clientIp(request: Request): string {
  return (request.headers.get('x-real-ip') || '').trim().slice(0, 64) || 'unknown';
}

export async function readFailures(email: string, ip: string = 'unknown'): Promise<number> {
  try {
    const { db } = getDatabase();
    const rows = await db.select().from(verification)
      .where(eq(verification.identifier, failedLoginKey(email, ip)))
      .limit(1);
    const row = rows[0];
    if (!row) return 0;
    if (row.expiresAt.getTime() <= Date.now()) return 0;
    const count = Number.parseInt(row.value, 10);
    return Number.isFinite(count) ? count : 0;
  } catch {
    // A broken counter must never lock a real user out: fail open.
    return 0;
  }
}

export async function noteFailure(email: string, ip: string = 'unknown'): Promise<void> {
  try {
    const { db } = getDatabase();
    const key = failedLoginKey(email, ip);
    const existing = (await db.select().from(verification).where(eq(verification.identifier, key)).limit(1))[0];
    const count = existing ? Number.parseInt(existing.value, 10) || 0 : 0;
    const expiresAt = new Date(Date.now() + FAILED_LOGIN_WINDOW_MS);
    if (existing) {
      await db.update(verification).set({ value: String(count + 1), expiresAt }).where(eq(verification.id, existing.id));
    } else {
      await db.insert(verification).values({ id: crypto.randomUUID(), identifier: key, value: '1', expiresAt });
    }
  } catch {
    // Counting is best effort; the IP rate limit still applies.
  }
}

export async function clearFailures(email: string, ip: string = 'unknown'): Promise<void> {
  try {
    const { db } = getDatabase();
    await db.delete(verification).where(eq(verification.identifier, failedLoginKey(email, ip)));
  } catch {
    // Best effort.
  }
}

export async function readEmail(request: Request): Promise<string | null> {
  try {
    const body = await request.clone().json();
    const email = typeof body?.email === 'string' ? body.email : '';
    return email.trim().toLowerCase() || null;
  } catch {
    return null;
  }
}
