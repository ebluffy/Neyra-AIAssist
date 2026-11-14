import type { WebThreadItem, WebThreadMessage, WebNote } from '@neyra/contracts';

export type ThreadItem = WebThreadItem;
export type ThreadMessage = WebThreadMessage;
export type NoteItem = WebNote;

export interface ThreadDetail {
  thread: ThreadItem;
  messages: ThreadMessage[];
  has_more: boolean;
  next_before: number | null;
}

export interface ThreadListResponse {
  items: ThreadItem[];
  next_cursor: string | null;
}

export interface NoteListResponse {
  items: NoteItem[];
  next_cursor: string | null;
}

export class HistoryApiError extends Error {
  status: number;
  code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'HistoryApiError';
    this.status = status;
    this.code = code;
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      accept: 'application/json',
      ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(init?.headers || {}),
    },
  });

  const body = await res.json().catch(() => null);

  if (!res.ok) {
    const code = body?.error || (res.status === 404 ? 'not_found' : 'request_failed');
    const msg = body?.message || `Ошибка запроса (${res.status})`;
    throw new HistoryApiError(msg, res.status, code);
  }

  // The core response wraps payloads in `data`
  if (body && typeof body === 'object' && 'data' in body && body.data !== null && body.data !== undefined) {
    return body.data as T;
  }

  return body as T;
}

// ==================== THREADS API ====================

export async function apiListThreads(params?: { limit?: number; cursor?: string }): Promise<ThreadListResponse> {
  const query = new URLSearchParams();
  if (params?.limit) query.set('limit', String(params.limit));
  if (params?.cursor) query.set('cursor', params.cursor);
  const qs = query.toString();
  return requestJson<ThreadListResponse>(`/api/threads${qs ? `?${qs}` : ''}`, { method: 'GET' });
}

export async function apiCreateThread(body: { title?: string } = {}): Promise<ThreadItem> {
  return requestJson<ThreadItem>('/api/threads', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function apiGetThread(
  threadId: string,
  params?: { limit?: number; before?: number }
): Promise<ThreadDetail> {
  const query = new URLSearchParams();
  if (params?.limit) query.set('limit', String(params.limit));
  if (params?.before !== undefined) query.set('before', String(params.before));
  const qs = query.toString();
  return requestJson<ThreadDetail>(`/api/threads/${encodeURIComponent(threadId)}${qs ? `?${qs}` : ''}`, {
    method: 'GET',
  });
}

export async function apiUpdateThread(
  threadId: string,
  body: { title?: string; archived?: boolean }
): Promise<ThreadItem> {
  return requestJson<ThreadItem>(`/api/threads/${encodeURIComponent(threadId)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export async function apiDeleteThread(threadId: string): Promise<boolean> {
  try {
    await requestJson<{ deleted: boolean }>(`/api/threads/${encodeURIComponent(threadId)}`, {
      method: 'DELETE',
    });
    return true;
  } catch (err) {
    if (err instanceof HistoryApiError && err.status === 404) {
      // 404 on delete is idempotent: already gone
      return true;
    }
    throw err;
  }
}

export async function apiAddThreadMessage(
  threadId: string,
  body: {
    content: string;
    role?: 'user' | 'assistant';
    attachments?: unknown[];
    model?: string;
    client_message_id?: string;
  }
): Promise<ThreadMessage> {
  return requestJson<ThreadMessage>(`/api/threads/${encodeURIComponent(threadId)}/messages`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function apiDeleteThreadMessage(threadId: string, messageId: string): Promise<boolean> {
  try {
    await requestJson<{ deleted: boolean }>(
      `/api/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}`,
      { method: 'DELETE' }
    );
    return true;
  } catch (err) {
    if (err instanceof HistoryApiError && err.status === 404) {
      return true;
    }
    throw err;
  }
}

// ==================== NOTES API ====================

export async function apiListNotes(params?: {
  thread_id?: string;
  limit?: number;
  cursor?: string;
}): Promise<NoteListResponse> {
  const query = new URLSearchParams();
  if (params?.thread_id) query.set('thread_id', params.thread_id);
  if (params?.limit) query.set('limit', String(params.limit));
  if (params?.cursor) query.set('cursor', params.cursor);
  const qs = query.toString();
  return requestJson<NoteListResponse>(`/api/notes${qs ? `?${qs}` : ''}`, { method: 'GET' });
}

export async function apiCreateNote(body: {
  text: string;
  thread_id?: string | null;
  pinned?: boolean;
}): Promise<NoteItem> {
  return requestJson<NoteItem>('/api/notes', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function apiUpdateNote(
  noteId: string,
  body: { text?: string; pinned?: boolean; thread_id?: string | null }
): Promise<NoteItem> {
  return requestJson<NoteItem>(`/api/notes/${encodeURIComponent(noteId)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export async function apiDeleteNote(noteId: string): Promise<boolean> {
  try {
    await requestJson<{ deleted: boolean }>(`/api/notes/${encodeURIComponent(noteId)}`, {
      method: 'DELETE',
    });
    return true;
  } catch (err) {
    if (err instanceof HistoryApiError && err.status === 404) {
      return true;
    }
    throw err;
  }
}

// ==================== ONE-TIME IMPORT ====================

export interface ImportResult {
  threadsCount: number;
  notesCount: number;
  error?: string;
}

export async function importLocalStorageData(userId: string): Promise<ImportResult> {
  if (typeof window === 'undefined' || !userId) {
    return { threadsCount: 0, notesCount: 0 };
  }

  const guardKey = `neyra:imported-to-db:${userId}`;
  if (window.localStorage.getItem(guardKey) === '1') {
    return { threadsCount: 0, notesCount: 0 };
  }

  const threadsStorageKey = `neyra:threads:${userId}`;
  const notesStorageKey = `neyra:notes:${userId}`;

  let localThreads: Array<{ id: string; title: string }> = [];
  let localNotes: Array<{ id?: string; title?: string; content?: string; text?: string; pinned?: boolean }> = [];

  try {
    const rawThreads = window.localStorage.getItem(threadsStorageKey);
    if (rawThreads) localThreads = JSON.parse(rawThreads);
  } catch {}

  try {
    const rawNotes = window.localStorage.getItem(notesStorageKey);
    if (rawNotes) localNotes = JSON.parse(rawNotes);
  } catch {}

  if (localThreads.length === 0 && localNotes.length === 0) {
    window.localStorage.setItem(guardKey, '1');
    return { threadsCount: 0, notesCount: 0 };
  }

  let importedThreads = 0;
  let importedNotes = 0;

  try {
    // 1. Import threads and messages
    for (const t of localThreads) {
      const createdThread = await apiCreateThread({ title: t.title });
      importedThreads++;

      const msgsKey = `neyra:thread-messages:${userId}:${t.id}`;
      const rawMsgs = window.localStorage.getItem(msgsKey);
      if (rawMsgs) {
        try {
          const msgs: Array<{ content?: string; role?: 'user' | 'assistant'; attachments?: unknown[]; model?: string }> =
            JSON.parse(rawMsgs);
          for (const m of msgs) {
            if (m.content) {
              await apiAddThreadMessage(createdThread.id, {
                content: m.content,
                role: m.role || 'user',
                attachments: m.attachments,
                model: m.model,
                client_message_id: crypto.randomUUID(),
              });
            }
          }
        } catch {}
      }
    }

    // 2. Import notes
    for (const n of localNotes) {
      const textParts = [];
      if (n.title && n.title !== 'Новая заметка') textParts.push(n.title);
      if (n.content) textParts.push(n.content);
      if (n.text) textParts.push(n.text);
      const text = textParts.join('\n\n').trim();

      if (text) {
        await apiCreateNote({ text, pinned: Boolean(n.pinned) });
        importedNotes++;
      }
    }

    // 3. Clear localStorage ONLY after complete success
    window.localStorage.removeItem(threadsStorageKey);
    window.localStorage.removeItem(notesStorageKey);
    for (const t of localThreads) {
      window.localStorage.removeItem(`neyra:thread-messages:${userId}:${t.id}`);
      window.localStorage.removeItem(`neyra:pinned-messages:${userId}:${t.id}`);
    }
    window.localStorage.setItem(guardKey, '1');

    return { threadsCount: importedThreads, notesCount: importedNotes };
  } catch (err) {
    // If import failed, DO NOT touch localStorage!
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      threadsCount: importedThreads,
      notesCount: importedNotes,
      error: errorMsg,
    };
  }
}
