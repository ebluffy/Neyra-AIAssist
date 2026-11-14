// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  apiListThreads,
  apiCreateThread,
  apiGetThread,
  apiUpdateThread,
  apiDeleteThread,
  apiAddThreadMessage,
  apiDeleteThreadMessage,
  apiListNotes,
  apiCreateNote,
  apiUpdateNote,
  apiDeleteNote,
  importLocalStorageData,
} from './history-client';

describe('history-client API and migration', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('apiListThreads calls /api/threads with query params', async () => {
    let capturedUrl = '';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ items: [{ id: 'th-1', title: 'Test' }], next_cursor: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const res = await apiListThreads({ limit: 15, cursor: 'cur-1' });
    expect(res.items).toHaveLength(1);
    expect(capturedUrl).toBe('/api/threads?limit=15&cursor=cur-1');
  });

  it('apiCreateThread calls POST /api/threads with body', async () => {
    let capturedBody: any;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ id: 'th-new', title: capturedBody.title }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const res = await apiCreateThread({ title: 'Новый диалог' });
    expect(res.id).toBe('th-new');
    expect(capturedBody.title).toBe('Новый диалог');
  });

  it('apiGetThread calls GET /api/threads/:id with pagination', async () => {
    let capturedUrl = '';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({
        thread: { id: 'th-1', title: 'Диалог' },
        messages: [{ id: 'm-1', role: 'user', content: 'Привет' }],
        has_more: false,
        next_before: null,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const res = await apiGetThread('th-1', { before: 100, limit: 20 });
    expect(res.messages).toHaveLength(1);
    expect(capturedUrl).toContain('/api/threads/th-1?');
    expect(capturedUrl).toContain('before=100');
    expect(capturedUrl).toContain('limit=20');
  });

  it('apiUpdateThread calls PATCH /api/threads/:id', async () => {
    let capturedMethod = '';
    let capturedBody: any;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      capturedMethod = init?.method || '';
      capturedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ id: 'th-1', title: capturedBody.title }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const res = await apiUpdateThread('th-1', { title: 'Переименовано' });
    expect(capturedMethod).toBe('PATCH');
    expect(capturedBody.title).toBe('Переименовано');
    expect(res.title).toBe('Переименовано');
  });

  it('apiDeleteThread calls DELETE /api/threads/:id', async () => {
    let capturedMethod = '';
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      capturedMethod = init?.method || '';
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const res = await apiDeleteThread('th-1');
    expect(capturedMethod).toBe('DELETE');
    expect(res).toBe(true);
  });

  it('apiListNotes calls /api/notes with thread_id and limit', async () => {
    let capturedUrl = '';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ items: [{ id: 'n-1', text: 'Заметка' }], next_cursor: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const res = await apiListNotes({ thread_id: 'th-1', limit: 10 });
    expect(res.items).toHaveLength(1);
    expect(capturedUrl).toBe('/api/notes?thread_id=th-1&limit=10');
  });

  it('apiCreateNote calls POST /api/notes', async () => {
    let capturedBody: any;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ id: 'n-1', text: capturedBody.text, pinned: capturedBody.pinned }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const res = await apiCreateNote({ text: 'Моя заметка', pinned: true });
    expect(res.id).toBe('n-1');
    expect(capturedBody.text).toBe('Моя заметка');
    expect(capturedBody.pinned).toBe(true);
  });

  it('apiUpdateNote calls PATCH /api/notes/:id', async () => {
    let capturedMethod = '';
    let capturedBody: any;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      capturedMethod = init?.method || '';
      capturedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ id: 'n-1', text: capturedBody.text }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const res = await apiUpdateNote('n-1', { text: 'Обновлённый текст' });
    expect(capturedMethod).toBe('PATCH');
    expect(capturedBody.text).toBe('Обновлённый текст');
    expect(res.text).toBe('Обновлённый текст');
  });

  it('apiDeleteNote calls DELETE /api/notes/:id', async () => {
    let capturedMethod = '';
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      capturedMethod = init?.method || '';
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const res = await apiDeleteNote('n-1');
    expect(capturedMethod).toBe('DELETE');
    expect(res).toBe(true);
  });

  describe('importLocalStorageData', () => {
    const userId = 'usr-test-import';

    it('skips import if already marked as imported', async () => {
      window.localStorage.setItem(`neyra:imported-to-db:${userId}`, '1');
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const result = await importLocalStorageData(userId);
      expect(result).toEqual({ threadsCount: 0, notesCount: 0 });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('migrates threads and notes, cleans up localStorage, and sets imported flag', async () => {
      const threads = [
        { id: 'old-th-1', title: 'Диалог про Python' },
      ];
      const messages = [
        { id: 'm-u1', role: 'user', content: 'Привет' },
        { id: 'm-a1', role: 'assistant', content: 'Здравствуйте!' },
      ];
      const notes = [
        { id: 'old-note-1', title: 'Заголовок', content: 'Тело заметки', pinned: true },
      ];

      window.localStorage.setItem(`neyra:threads:${userId}`, JSON.stringify(threads));
      window.localStorage.setItem(`neyra:thread-messages:${userId}:old-th-1`, JSON.stringify(messages));
      window.localStorage.setItem(`neyra:notes:${userId}`, JSON.stringify(notes));

      const createdThreads: any[] = [];
      const addedMessages: any[] = [];
      const createdNotes: any[] = [];

      vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        const path = String(url);
        const method = init?.method || 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : null;

        if (path === '/api/threads' && method === 'POST') {
          const t = { id: `new-th-${createdThreads.length + 1}`, title: body.title };
          createdThreads.push(t);
          return new Response(JSON.stringify(t), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (path.includes('/messages') && method === 'POST') {
          addedMessages.push(body);
          return new Response(JSON.stringify({ id: `msg-${addedMessages.length}`, ...body }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (path === '/api/notes' && method === 'POST') {
          const n = { id: `new-n-${createdNotes.length + 1}`, ...body };
          createdNotes.push(n);
          return new Response(JSON.stringify(n), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response('Not found', { status: 404 });
      }));

      const res = await importLocalStorageData(userId);
      expect(res.threadsCount).toBe(1);
      expect(res.notesCount).toBe(1);

      expect(createdThreads).toHaveLength(1);
      expect(createdThreads[0].title).toBe('Диалог про Python');
      expect(addedMessages).toHaveLength(2);
      expect(addedMessages[0].role).toBe('user');
      expect(addedMessages[1].role).toBe('assistant');
      expect(createdNotes).toHaveLength(1);
      expect(createdNotes[0].text).toContain('Заголовок');
      expect(createdNotes[0].pinned).toBe(true);

      // Verify localStorage was cleaned up
      expect(window.localStorage.getItem(`neyra:threads:${userId}`)).toBeNull();
      expect(window.localStorage.getItem(`neyra:thread-messages:${userId}:old-th-1`)).toBeNull();
      expect(window.localStorage.getItem(`neyra:notes:${userId}`)).toBeNull();

      // Verify migration flag set
      expect(window.localStorage.getItem(`neyra:imported-to-db:${userId}`)).toBe('1');
    });

    it('leaves localStorage intact and does not set imported flag if import throws an error', async () => {
      const threads = [{ id: 'th-err', title: 'Ошибка' }];
      window.localStorage.setItem(`neyra:threads:${userId}`, JSON.stringify(threads));

      vi.stubGlobal('fetch', vi.fn(async () => {
        return new Response('Server error', { status: 500 });
      }));

      const res = await importLocalStorageData(userId);
      expect(res.error).toBeTruthy();

      // Flag NOT set
      expect(window.localStorage.getItem(`neyra:imported-to-db:${userId}`)).toBeNull();
      // Data preserved
      expect(window.localStorage.getItem(`neyra:threads:${userId}`)).toBeTruthy();
    });
  });
});
