/** Клиент BFF истории чатов: список тредов, сообщения, переименование и архив. */
import { StoredAttachmentSchema, type StoredAttachment } from '@neyra/contracts';

export interface HistoryThread {
  id: string;
  title: string;
  pinned: boolean;
  updatedAt: string;
}

export interface HistoryMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status: string;
  errorCode: string | null;
  attachments: StoredAttachment[] | null;
}

interface ApiEnvelope<T> {
  ok?: boolean;
  data?: T;
}

async function readJson<T>(response: Response): Promise<T | null> {
  if (!response.ok) return null;
  try {
    const payload = (await response.json()) as ApiEnvelope<T>;
    return payload?.data ?? null;
  } catch {
    return null;
  }
}

function toIso(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  return new Date(0).toISOString();
}

export function normaliseHistoryThread(raw: unknown): HistoryThread | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  if (typeof item.id !== 'string' || !item.id.trim()) return null;
  return {
    id: item.id,
    title: typeof item.title === 'string' && item.title.trim() ? item.title : 'Диалог',
    pinned: item.pinned === true,
    updatedAt: toIso(item.updatedAt),
  };
}

export function normaliseHistoryMessage(raw: unknown): HistoryMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  if (item.role !== 'user' && item.role !== 'assistant') return null;
  if (typeof item.content !== 'string') return null;
  let attachments: StoredAttachment[] | null = null;
  if (Array.isArray(item.attachments)) {
    const parsed = StoredAttachmentSchema.array().safeParse(item.attachments);
    attachments = parsed.success && parsed.data.length > 0 ? parsed.data : null;
  }
  return {
    id: typeof item.id === 'string' ? item.id : crypto.randomUUID(),
    role: item.role,
    content: item.content,
    status: typeof item.status === 'string' ? item.status : 'done',
    errorCode: typeof item.errorCode === 'string' ? item.errorCode : null,
    attachments,
  };
}

/** null — API недоступен: вызывающий не должен считать это пустым списком. */
export async function fetchThreads(signal?: AbortSignal): Promise<HistoryThread[] | null> {
  const response = await fetch('/api/conversations?limit=100', {
    signal,
    headers: { accept: 'application/json' },
  });
  const data = await readJson<{ items?: unknown[] }>(response);
  if (!data || !Array.isArray(data.items)) return null;
  return data.items.flatMap((item) => {
    const thread = normaliseHistoryThread(item);
    return thread ? [thread] : [];
  });
}

export type ConversationMeta = { archived: boolean; title?: string } | 'missing' | null;

/** Для локальных тредов: 404 значит «ещё не записан», archived — «удалён на другом устройстве». */
export async function fetchConversationMeta(
  id: string,
  signal?: AbortSignal,
): Promise<ConversationMeta> {
  const response = await fetch(
    `/api/conversations/${encodeURIComponent(id)}?message_limit=1`,
    { signal, headers: { accept: 'application/json' } },
  );
  if (response.status === 404) return 'missing';
  if (!response.ok) return null;
  try {
    const payload = (await response.json()) as ApiEnvelope<{
      conversation?: { archivedAt?: string | null; title?: string };
    }>;
    const conversation = payload?.data?.conversation;
    if (!conversation) return null;
    return {
      archived: Boolean(conversation.archivedAt),
      ...(typeof conversation.title === 'string' ? { title: conversation.title } : {}),
    };
  } catch {
    return null;
  }
}

export interface HistoryPage {
  messages: HistoryMessage[];
  total: number;
  has_more: boolean;
}

const MESSAGE_PAGE_SIZE = 500;
const MESSAGE_PAGE_LIMIT = 20;

/**
 * Последние сообщения треда: сервер отдаёт страницы от новых к старым,
 * клиент склеивает их в хронологическом порядке. Старые страницы
 * подгружаются, пока есть has_more (с разумным потолком).
 */
export async function fetchThreadMessages(
  id: string,
  signal?: AbortSignal,
): Promise<HistoryPage | null> {
  let offset = 0;
  let total = 0;
  let messages: HistoryMessage[] = [];
  for (let page = 0; page < MESSAGE_PAGE_LIMIT; page += 1) {
    const response = await fetch(
      `/api/conversations/${encodeURIComponent(id)}`
        + `?message_limit=${MESSAGE_PAGE_SIZE}&message_offset=${offset}&message_order=desc`,
      { signal, headers: { accept: 'application/json' } },
    );
    const data = await readJson<{ messages?: unknown[]; total?: number; has_more?: boolean }>(response);
    if (!data || !Array.isArray(data.messages)) return null;
    const pageMessages = data.messages.flatMap((item) => {
      const message = normaliseHistoryMessage(item);
      return message ? [message] : [];
    });
    messages = [...pageMessages, ...messages];
    total = Number(data.total ?? messages.length);
    if (!data.has_more) break;
    offset += MESSAGE_PAGE_SIZE;
  }
  return { messages, total, has_more: messages.length < total };
}

export async function archiveThread(id: string): Promise<boolean> {
  const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { accept: 'application/json' },
  });
  // 404 — локальный тред, которого ещё нет на сервере: локальное удаление ок.
  return response.ok || response.status === 404;
}

/** Серверное удаление обмена: ответ и предшествующий вопрос. */
export async function deleteMessageExchange(
  conversationId: string,
  messageId: string,
): Promise<boolean> {
  const response = await fetch(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`,
    { method: 'DELETE', headers: { accept: 'application/json' } },
  );
  return response.ok || response.status === 404;
}

export async function renameThread(id: string, title: string): Promise<boolean> {
  const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ title }),
  });
  return response.ok;
}

export async function setThreadPinned(id: string, pinned: boolean): Promise<boolean> {
  const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ pinned }),
  });
  return response.ok;
}
