import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { getDatabase } from './db';
import { invite } from '../db/schema';

// AR-2: регистрация только по инвайтам. Токен живёт только в ссылке/письме;
// в базе — sha256, срок действия и факт использования.
export const INVITE_TTL_MS = 24 * 60 * 60 * 1000;

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function generateInviteToken(): string {
  return randomBytes(24).toString('base64url');
}

export function readInviteToken(body: unknown): string | null {
  const value = (body as { invite?: unknown } | null)?.invite;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export type InviteCheck = 'ok' | 'not-found' | 'used' | 'expired' | 'revoked' | 'error';

// Gate для регистрации: ошибка БД закрывает регистрацию (fail-closed), а не открывает.
export async function checkInvite(token: string): Promise<InviteCheck> {
  try {
    const { db } = getDatabase();
    const rows = await db.select().from(invite)
      .where(eq(invite.tokenHash, hashInviteToken(token)))
      .limit(1);
    const row = rows[0];
    if (!row) return 'not-found';
    if (row.revokedAt) return 'revoked';
    if (row.usedAt) return 'used';
    if (row.expiresAt.getTime() <= Date.now()) return 'expired';
    return 'ok';
  } catch {
    return 'error';
  }
}

// Одноразовость атомарна: UPDATE … WHERE used_at IS NULL RETURNING. Если вернулся
// пустой результат — инвайт уже потрачен параллельно, регистрация не должна была пройти.
export async function consumeInvite(token: string, usedBy: string): Promise<boolean> {
  try {
    const { db } = getDatabase();
    const rows = await db.update(invite)
      .set({ usedBy, usedAt: new Date() })
      .where(and(
        eq(invite.tokenHash, hashInviteToken(token)),
        isNull(invite.usedAt),
        isNull(invite.revokedAt),
        gt(invite.expiresAt, new Date()),
      ))
      .returning({ id: invite.id });
    return rows.length === 1;
  } catch {
    return false;
  }
}
