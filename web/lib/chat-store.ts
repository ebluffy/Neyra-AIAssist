import { and, asc, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import { getDatabase } from './db';
import { conversation, folder, message } from '../db/schema';

export type Conversation = typeof conversation.$inferSelect;
export type ChatMessage = typeof message.$inferSelect;

export interface NewChatMessage {
  /** Клиентский id: нужен, чтобы удаление/retry совпадали после reload. */
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  model?: string | null;
  status?: string;
  errorCode?: string | null;
  attachments?: unknown;
}

export interface ConversationPatch {
  title?: string;
  pinned?: boolean;
  folderId?: string | null;
  archived?: boolean;
}

export function deriveConversationTitle(text: string): string {
  const line = (text || '').split('\n')[0].replace(/\s+/g, ' ').trim();
  return (line || 'Новый диалог').slice(0, 80);
}

function db() {
  return getDatabase().db;
}

export function clampLimit(value: number | undefined, fallback: number, max: number): number {
  return Math.max(1, Math.min(Number.isFinite(value) ? Number(value) : fallback, max));
}

export function clampOffset(value: number | undefined): number {
  return Math.max(0, Number.isFinite(value) ? Number(value) : 0);
}

export function conversationOwnerWhere(userId: string) {
  return eq(conversation.userId, userId);
}

export function conversationOwnershipWhere(userId: string, id: string) {
  return and(eq(conversation.id, id), eq(conversation.userId, userId));
}

export function folderOwnershipWhere(userId: string, id: string) {
  return and(eq(folder.id, id), eq(folder.userId, userId));
}

async function ownedConversation(userId: string, id: string): Promise<Conversation | null> {
  const rows = await db()
    .select()
    .from(conversation)
    .where(conversationOwnershipWhere(userId, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function ensureConversation(
  userId: string,
  id: string,
  firstText: string,
  model?: string | null,
): Promise<Conversation> {
  const existing = await ownedConversation(userId, id);
  if (existing) {
    if (existing.archivedAt) {
      const revived = await db()
        .update(conversation)
        .set({ archivedAt: null, updatedAt: new Date() })
        .where(conversationOwnershipWhere(userId, id))
        .returning();
      return revived[0] ?? existing;
    }
    return existing;
  }
  const any = await db()
    .select({ id: conversation.id })
    .from(conversation)
    .where(eq(conversation.id, id))
    .limit(1);
  if (any.length > 0) throw new Error('conversation_forbidden');
  await db()
    .insert(conversation)
    .values({
      id,
      userId,
      title: deriveConversationTitle(firstText),
      model: model ? model.slice(0, 200) : null,
    })
    .onConflictDoNothing();
  const row = await ownedConversation(userId, id);
  if (!row) throw new Error('conversation_forbidden');
  return row;
}

export async function appendMessage(
  userId: string,
  conversationId: string,
  item: NewChatMessage,
): Promise<ChatMessage> {
  const owner = await ownedConversation(userId, conversationId);
  if (!owner) throw new Error('conversation_not_found');
  if (owner.archivedAt) throw new Error('conversation_archived');
  const model = item.model ? item.model.slice(0, 200) : null;
  const rows = await db()
    .insert(message)
    .values({
      id: item.id ?? crypto.randomUUID(),
      conversationId,
      role: item.role,
      content: item.content,
      model,
      status: item.status || 'done',
      errorCode: item.errorCode || null,
      attachments: item.attachments ?? null,
    })
    .returning();
  await db()
    .update(conversation)
    .set({
      updatedAt: new Date(),
      ...(model ? { model } : {}),
    })
    .where(conversationOwnershipWhere(userId, conversationId));
  return rows[0];
}

export interface ConversationPage {
  items: Conversation[];
  total: number;
  has_more: boolean;
}

export async function listConversations(
  userId: string,
  options: { includeArchived?: boolean; limit?: number; offset?: number } = {},
): Promise<ConversationPage> {
  const where = options.includeArchived
    ? conversationOwnerWhere(userId)
    : and(conversationOwnerWhere(userId), isNull(conversation.archivedAt));
  const limit = clampLimit(options.limit, 50, 100);
  const offset = clampOffset(options.offset);
  const [total_row] = await db()
    .select({ count: sql<number>`count(*)::int` })
    .from(conversation)
    .where(where);
  const rows = await db()
    .select()
    .from(conversation)
    .where(where)
    .orderBy(desc(conversation.pinned), desc(conversation.updatedAt), asc(conversation.id))
    .limit(limit + 1)
    .offset(offset);
  return {
    items: rows.slice(0, limit),
    total: Number(total_row?.count ?? 0),
    has_more: rows.length > limit,
  };
}

export async function getConversation(
  userId: string,
  id: string,
): Promise<Conversation | null> {
  return ownedConversation(userId, id);
}

export interface MessagePage {
  items: ChatMessage[];
  total: number;
  has_more: boolean;
}

export async function listMessages(
  userId: string,
  conversationId: string,
  options: { limit?: number; offset?: number; order?: 'asc' | 'desc' } = {},
): Promise<MessagePage> {
  const owner = await ownedConversation(userId, conversationId);
  if (!owner) throw new Error('conversation_not_found');
  const limit = clampLimit(options.limit, 200, 500);
  const offset = clampOffset(options.offset);
  const [total_row] = await db()
    .select({ count: sql<number>`count(*)::int` })
    .from(message)
    .where(eq(message.conversationId, conversationId));
  const descending = options.order === 'desc';
  const rows = await db()
    .select()
    .from(message)
    .where(eq(message.conversationId, conversationId))
    .orderBy(
      descending ? desc(message.createdAt) : asc(message.createdAt),
      descending ? desc(message.id) : asc(message.id),
    )
    .limit(limit + 1)
    .offset(offset);
  const items = rows.slice(0, limit);
  if (descending) items.reverse();
  return {
    items,
    total: Number(total_row?.count ?? 0),
    has_more: rows.length > limit,
  };
}

export async function messageExists(
  userId: string,
  conversationId: string,
  messageId: string,
): Promise<boolean> {
  const owner = await ownedConversation(userId, conversationId);
  if (!owner) throw new Error('conversation_not_found');
  const rows = await db()
    .select({ id: message.id })
    .from(message)
    .where(and(eq(message.id, messageId), eq(message.conversationId, conversationId)))
    .limit(1);
  return rows.length > 0;
}

/**
 * Записывает ответ: существующую строку обновляет на месте (retry сохраняет
 * позицию и createdAt), новую — вставляет.
 */
export async function upsertMessage(
  userId: string,
  conversationId: string,
  item: NewChatMessage,
): Promise<ChatMessage> {
  const owner = await ownedConversation(userId, conversationId);
  if (!owner) throw new Error('conversation_not_found');
  if (owner.archivedAt) throw new Error('conversation_archived');
  const model = item.model ? item.model.slice(0, 200) : null;
  if (item.id) {
    const rows = await db()
      .update(message)
      .set({
        content: item.content,
        model,
        status: item.status || 'done',
        errorCode: item.errorCode || null,
        attachments: item.attachments ?? null,
      })
      .where(and(eq(message.id, item.id), eq(message.conversationId, conversationId)))
      .returning();
    if (rows[0]) {
      await db()
        .update(conversation)
        .set({ updatedAt: new Date(), ...(model ? { model } : {}) })
        .where(conversationOwnershipWhere(userId, conversationId));
      return rows[0];
    }
  }
  return appendMessage(userId, conversationId, item);
}

/** Удаляет одно сообщение; при withPreviousUser — пару «вопрос + ответ». */
export async function deleteMessage(
  userId: string,
  conversationId: string,
  messageId: string,
  options: { withPreviousUser?: boolean } = {},
): Promise<boolean> {
  const owner = await ownedConversation(userId, conversationId);
  if (!owner) throw new Error('conversation_not_found');
  const rows = await db()
    .select()
    .from(message)
    .where(and(eq(message.id, messageId), eq(message.conversationId, conversationId)))
    .limit(1);
  const target = rows[0];
  if (!target) return false;
  if (options.withPreviousUser && target.role === 'assistant') {
    const previous = await db()
      .select({ id: message.id, role: message.role })
      .from(message)
      .where(
        and(
          eq(message.conversationId, conversationId),
          lt(message.createdAt, target.createdAt),
        ),
      )
      .orderBy(desc(message.createdAt), desc(message.id))
      .limit(1);
    if (previous[0]?.role === 'user') {
      await db().delete(message).where(eq(message.id, previous[0].id));
    }
  }
  await db().delete(message).where(eq(message.id, messageId));
  return true;
}

export async function countMessages(userId: string, conversationId: string): Promise<number> {
  const owner = await ownedConversation(userId, conversationId);
  if (!owner) throw new Error('conversation_not_found');
  const [row] = await db()
    .select({ count: sql<number>`count(*)::int` })
    .from(message)
    .where(eq(message.conversationId, conversationId));
  return Number(row?.count ?? 0);
}

export async function updateConversation(
  userId: string,
  id: string,
  patch: ConversationPatch,
): Promise<Conversation | null> {
  const owner = await ownedConversation(userId, id);
  if (!owner) return null;
  const values: Record<string, unknown> = { updatedAt: new Date() };
  if (typeof patch.title === 'string') values.title = patch.title.trim().slice(0, 200) || 'Новый диалог';
  if (typeof patch.pinned === 'boolean') values.pinned = patch.pinned;
  if (patch.folderId !== undefined) {
    if (patch.folderId !== null) {
      const ownsFolder = await db()
        .select({ id: folder.id })
        .from(folder)
        .where(folderOwnershipWhere(userId, patch.folderId))
        .limit(1);
      if (!ownsFolder.length) throw new Error('folder_not_found');
    }
    values.folderId = patch.folderId;
  }
  if (typeof patch.archived === 'boolean') values.archivedAt = patch.archived ? new Date() : null;
  const rows = await db()
    .update(conversation)
    .set(values)
    .where(conversationOwnershipWhere(userId, id))
    .returning();
  return rows[0] ?? null;
}

export async function deleteConversation(userId: string, id: string): Promise<boolean> {
  const rows = await db()
    .update(conversation)
    .set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(conversationOwnershipWhere(userId, id))
    .returning({ id: conversation.id });
  return rows.length > 0;
}

export async function listFolders(userId: string) {
  return db()
    .select()
    .from(folder)
    .where(eq(folder.userId, userId))
    .orderBy(asc(folder.position), asc(folder.createdAt));
}
