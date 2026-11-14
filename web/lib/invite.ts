import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { getDatabase } from './db';
import { invite } from '../db/schema';

// AR-2/AR-35: регистрация по инвайтам. Токен живёт только в ссылке; в базе —
// sha256, лимит использований (max_uses, null — без лимита), срок (null — без
// срока) и необязательная привязка к email.
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

export type InviteCheck = 'ok' | 'not-found' | 'used' | 'expired' | 'revoked' | 'email-mismatch' | 'error';

export interface InviteRules {
  maxUses: number | null;
  usedCount: number;
  expiresAt: Date | string | null;
  revokedAt: Date | string | null;
  email: string | null;
}

/** Исчерпан ли лимит использований (null — без лимита). */
export function isInviteExhausted(row: Pick<InviteRules, 'maxUses' | 'usedCount'>): boolean {
  return row.maxUses !== null && row.maxUses !== undefined && row.usedCount >= row.maxUses;
}

/** Совпадает ли адрес с привязкой инвайта (без привязки — любой адрес). */
export function inviteEmailMatches(row: Pick<InviteRules, 'email'>, email: string | null | undefined): boolean {
  if (!row.email) return true;
  return (email ?? '').trim().toLowerCase() === row.email.trim().toLowerCase();
}

// Gate для регистрации: ошибка БД закрывает регистрацию (fail-closed), а не открывает.
export async function checkInvite(token: string, email?: string | null): Promise<InviteCheck> {
  try {
    const { db } = getDatabase();
    const rows = await db.select().from(invite)
      .where(eq(invite.tokenHash, hashInviteToken(token)))
      .limit(1);
    const row = rows[0];
    if (!row) return 'not-found';
    if (row.revokedAt) return 'revoked';
    if (isInviteExhausted(row)) return 'used';
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return 'expired';
    if (!inviteEmailMatches(row, email)) return 'email-mismatch';
    return 'ok';
  } catch {
    return 'error';
  }
}

// Расход атомарен: UPDATE … WHERE (лимит не исчерпан, не истёк, не отозван,
// email совпадает) с used_count + 1. Параллельные регистрации при max_uses=2
// дают ровно две успешные и отказ третьей; при max_uses=1 — одну.
export async function consumeInvite(token: string, usedBy: string, email: string): Promise<boolean> {
  try {
    const { db } = getDatabase();
    const now = new Date();
    const rows = await db.update(invite)
      .set({ usedCount: sql`${invite.usedCount} + 1`, usedBy, usedAt: now })
      .where(and(
        eq(invite.tokenHash, hashInviteToken(token)),
        isNull(invite.revokedAt),
        or(isNull(invite.expiresAt), gt(invite.expiresAt, now)),
        or(isNull(invite.maxUses), sql`${invite.usedCount} < ${invite.maxUses}`),
        or(isNull(invite.email), sql`lower(${invite.email}) = lower(${email})`),
      ))
      .returning({ id: invite.id });
    return rows.length === 1;
  } catch {
    return false;
  }
}

// Возврат расхода, если регистрация не прошла после атомарного списания.
// Уменьшаем только наше использование; «последнее использование» чистим, когда
// счётчик дошёл до нуля, чтобы список не показывал неудавшуюся попытку.
export async function releaseInvite(token: string): Promise<boolean> {
  try {
    const { db } = getDatabase();
    const rows = await db.update(invite)
      .set({
        usedCount: sql`greatest(${invite.usedCount} - 1, 0)`,
        usedBy: sql`case when ${invite.usedCount} - 1 <= 0 then null else ${invite.usedBy} end`,
        usedAt: sql`case when ${invite.usedCount} - 1 <= 0 then null else ${invite.usedAt} end`,
      })
      .where(and(eq(invite.tokenHash, hashInviteToken(token)), gt(invite.usedCount, 0)))
      .returning({ id: invite.id });
    return rows.length === 1;
  } catch {
    return false;
  }
}
