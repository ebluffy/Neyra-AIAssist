import { eq } from 'drizzle-orm';
import { getDatabase } from './db';
import { verification } from '../db/schema';

// Per-account brake for failed email/password sign-ins, on top of the IP rate limit.
// Stored in the existing verification key-value table (identifier/value/expiresAt),
// so no extra table is needed and rows expire on their own.
export const FAILED_LOGIN_MAX_ATTEMPTS = 5;
export const FAILED_LOGIN_WINDOW_MS = 15 * 60 * 1000;

const KEY_PREFIX = 'login-fail:';

export function failedLoginKey(email: string): string {
  return `${KEY_PREFIX}${email.trim().toLowerCase()}`;
}

export async function readFailures(email: string): Promise<number> {
  try {
    const { db } = getDatabase();
    const rows = await db.select().from(verification)
      .where(eq(verification.identifier, failedLoginKey(email)))
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

export async function noteFailure(email: string): Promise<void> {
  try {
    const { db } = getDatabase();
    const key = failedLoginKey(email);
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

export async function clearFailures(email: string): Promise<void> {
  try {
    const { db } = getDatabase();
    await db.delete(verification).where(eq(verification.identifier, failedLoginKey(email)));
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
