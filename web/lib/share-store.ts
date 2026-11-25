import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, gt, isNull, ne, or } from 'drizzle-orm';
import { getDatabase } from './db';
import { conversation, share } from '../db/schema';
import { listMessages, type Conversation } from './chat-store';

export type ShareTtl = '24h' | '7d' | '30d' | 'never';
export const SHARE_TTLS: ShareTtl[] = ['24h', '7d', '30d', 'never'];

const TTL_MS: Record<Exclude<ShareTtl, 'never'>, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

function db() {
  return getDatabase().db;
}

export function shareExpiry(ttl: ShareTtl, now = new Date()): Date | null {
  if (ttl === 'never') return null;
  return new Date(now.getTime() + TTL_MS[ttl]);
}

export function hashShareToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function isShareTokenFormat(token: string): boolean {
  return TOKEN_RE.test(token);
}

export interface CreatedShare {
  id: string;
  token: string;
  expiresAt: Date | null;
}

/** Одна активная ссылка на диалог: предыдущие отзываются. */
export async function createConversationShare(
  userId: string,
  conversationId: string,
  ttl: ShareTtl,
): Promise<CreatedShare | null> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = shareExpiry(ttl);
  const id = crypto.randomUUID();
  const created = await db().transaction(async (tx) => {
    // Блокируем строку диалога: архив и параллельное создание ссылки встают
    // в очередь, а архив проверяется уже под блокировкой.
    const locked = await tx
      .select()
      .from(conversation)
      .where(and(eq(conversation.id, conversationId), eq(conversation.userId, userId)))
      .for('update');
    const room = locked[0];
    if (!room) return false;
    if (room.archivedAt) throw new Error('conversation_archived');
    await tx.insert(share).values({
      id,
      conversationId,
      userId,
      tokenHash: hashShareToken(token),
      expiresAt,
    });
    // Новая ссылка отзывает предыдущие в той же транзакции.
    await tx
      .update(share)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(share.userId, userId),
          eq(share.conversationId, conversationId),
          isNull(share.revokedAt),
          ne(share.id, id),
        ),
      );
    return true;
  });
  return created ? { id, token, expiresAt } : null;
}

export interface ActiveShare {
  expiresAt: Date | null;
}

export async function getActiveShare(
  userId: string,
  conversationId: string,
): Promise<ActiveShare | null> {
  const rows = await db()
    .select({ expiresAt: share.expiresAt })
    .from(share)
    .where(
      and(
        eq(share.userId, userId),
        eq(share.conversationId, conversationId),
        isNull(share.revokedAt),
        or(isNull(share.expiresAt), gt(share.expiresAt, new Date())),
      ),
    )
    .orderBy(desc(share.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function revokeConversationShares(
  userId: string,
  conversationId: string,
): Promise<number> {
  const rows = await db()
    .update(share)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(share.userId, userId),
        eq(share.conversationId, conversationId),
        isNull(share.revokedAt),
      ),
    )
    .returning({ id: share.id });
  return rows.length;
}

export interface SharedConversation {
  conversation: Conversation;
  messages: Awaited<ReturnType<typeof listMessages>>['items'];
  total: number;
  has_more: boolean;
}

/** Доступ только для вошедших: сессию проверяет страница, здесь — токен. */
export async function resolveShareToken(token: string): Promise<SharedConversation | null> {
  if (!isShareTokenFormat(token)) return null;
  const rows = await db()
    .select({ conversation })
    .from(share)
    .innerJoin(conversation, eq(share.conversationId, conversation.id))
    .where(
      and(
        eq(share.tokenHash, hashShareToken(token)),
        isNull(share.revokedAt),
        or(isNull(share.expiresAt), gt(share.expiresAt, new Date())),
        isNull(conversation.archivedAt),
      ),
    )
    .limit(1);
  const room = rows[0]?.conversation;
  if (!room) return null;
  const page = await listMessages(room.userId, room.id, { limit: 500, order: 'desc' });
  return {
    conversation: room,
    messages: page.items,
    total: page.total,
    has_more: page.has_more,
  };
}
