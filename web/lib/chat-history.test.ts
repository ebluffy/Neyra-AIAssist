import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  archiveThread,
  deleteMessageExchange,
  fetchConversationMeta,
  fetchThreadMessages,
  fetchThreads,
  normaliseHistoryMessage,
  normaliseHistoryThread,
  renameThread,
  setThreadPinned,
} from './chat-history';

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('history normalisers', () => {
  it('drops records without id/role/content', () => {
    expect(normaliseHistoryThread({})).toBeNull();
    expect(normaliseHistoryThread({ id: 'c1' })).toMatchObject({ id: 'c1', title: 'Диалог' });
    expect(normaliseHistoryMessage({ role: 'system', content: 'x' })).toBeNull();
    expect(normaliseHistoryMessage({ role: 'user', content: 42 })).toBeNull();
  });

  it('keeps valid attachments and ignores corrupt ones', () => {
    const attachment = {
      id: 'a'.repeat(32),
      kind: 'image',
      name: 'cat.png',
      mime: 'image/png',
      size: 10,
    };
    expect(
      normaliseHistoryMessage({ role: 'user', content: 'x', attachments: [attachment] })?.attachments,
    ).toEqual([attachment]);
    expect(
      normaliseHistoryMessage({ role: 'user', content: 'x', attachments: [{ nope: true }] })
        ?.attachments,
    ).toBeNull();
  });

  it('turns an unknown timestamp into the epoch instead of crashing', () => {
    expect(normaliseHistoryThread({ id: 'c1', updatedAt: 123 })?.updatedAt).toBe(
      new Date(0).toISOString(),
    );
  });
});

describe('history API client', () => {
  it('lists threads and clamps invalid payloads', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ ok: true, data: { items: [{ id: 'c1', title: 'Тема' }, {}] } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchThreads()).resolves.toEqual([
      expect.objectContaining({ id: 'c1', title: 'Тема' }),
    ]);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/conversations?limit=100');
  });

  it('keeps a failed thread list distinguishable from an empty one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'unavailable' }, 503)));
    await expect(fetchThreads()).resolves.toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad gateway', { status: 502 })));
    await expect(fetchThreads()).resolves.toBeNull();
  });

  it('returns null when the conversation is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'not_found' }, 404)));
    await expect(fetchThreadMessages('c1')).resolves.toBeNull();
  });

  it('loads the newest messages first and walks older pages', async () => {
    const pageOne = {
      messages: [
        { id: 'm501', role: 'assistant', content: 'новый ответ', status: 'done' },
      ],
      total: 501,
      has_more: true,
    };
    const pageTwo = {
      messages: [{ id: 'm1', role: 'user', content: 'старый вопрос', status: 'done' }],
      total: 501,
      has_more: false,
    };
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ ok: true, data: fetchMock.mock.calls.length === 1 ? pageOne : pageTwo }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const page = await fetchThreadMessages('c1');
    expect(page?.messages.map((item) => item.id)).toEqual(['m1', 'm501']);
    // Сервер сообщил total=501, а в моке пришло два сообщения: остаток честно виден.
    expect(page?.has_more).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain('message_order=desc');
    expect(String(fetchMock.mock.calls[1][0])).toContain('message_offset=500');
  });

  it('maps server messages to the chat shape', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          ok: true,
          data: {
            messages: [{ id: 'm1', role: 'assistant', content: 'ответ', status: 'done' }],
            total: 1,
            has_more: false,
          },
        }),
      ),
    );
    const page = await fetchThreadMessages('c1');
    expect(page?.messages).toEqual([
      {
        id: 'm1',
        role: 'assistant',
        content: 'ответ',
        status: 'done',
        errorCode: null,
        attachments: null,
      },
    ]);
  });

  it('distinguishes a missing local thread from an archived one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'not_found' }, 404)));
    await expect(fetchConversationMeta('c1')).resolves.toBe('missing');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          ok: true,
          data: { conversation: { id: 'c1', title: 'Тема', archivedAt: '2026-11-20T10:00:00Z' } },
        }),
      ),
    );
    await expect(fetchConversationMeta('c1')).resolves.toEqual({
      archived: true,
      title: 'Тема',
    });

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'unavailable' }, 503)));
    await expect(fetchConversationMeta('c1')).resolves.toBeNull();
  });

  it('reports archive/rename/pin success by status', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(archiveThread('c1')).resolves.toBe(true);
    await expect(renameThread('c1', 'Новое')).resolves.toBe(true);
    await expect(setThreadPinned('c1', true)).resolves.toBe(true);
    expect(fetchMock.mock.calls.map(([, init]) => (init as RequestInit).method)).toEqual([
      'DELETE',
      'PATCH',
      'PATCH',
    ]);
  });

  it('returns false when the server rejects the mutation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'forbidden' }, 403)));
    await expect(archiveThread('c1')).resolves.toBe(false);
    await expect(renameThread('c1', 'Новое')).resolves.toBe(false);
    await expect(setThreadPinned('c1', false)).resolves.toBe(false);
    await expect(deleteMessageExchange('c1', 'm1')).resolves.toBe(false);
  });

  it('treats a missing local thread as already archived', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'not_found' }, 404)));
    await expect(archiveThread('local-only')).resolves.toBe(true);
    await expect(deleteMessageExchange('local-only', 'm1')).resolves.toBe(true);
  });

  it('deletes an exchange through the nested message route', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(deleteMessageExchange('c1', 'm1')).resolves.toBe(true);
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/conversations/c1/messages/m1');
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('DELETE');
  });
});
