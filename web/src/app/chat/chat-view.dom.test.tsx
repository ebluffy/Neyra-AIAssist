// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ChatView } from './chat-view';
import { TextField } from '../../components/ui';
import { resolveChatId, resolveTabKey } from '../../../lib/chat-id';
import { ru } from '../../i18n';

const mockReplace = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace, refresh: vi.fn() }),
}));

beforeAll(() => { Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear(); window.name = ''; mockReplace.mockClear(); });

function historyResponse(): Response {
  return new Response(JSON.stringify({ ok: true, data: { items: [], messages: [] } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** История чата ходит в /api/conversations; в этих тестах она пустая. */
function stubFetch(mock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.startsWith('/api/conversations') && (!init || !init.method || init.method === 'GET')) {
        return Promise.resolve(historyResponse());
      }
      return mock(url, init);
    }),
  );
}

function chatPosts(fetchMock: ReturnType<typeof vi.fn>): [unknown, RequestInit | undefined][] {
  return fetchMock.mock.calls.filter(
    ([url, init]) => String(url) === '/api/chat' && Boolean((init as RequestInit | undefined)?.body),
  ) as [unknown, RequestInit | undefined][];
}

function sseResponse(tokenText = 'привет'): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: {"type":"token","text":"${tokenText}"}\n\n`));
      controller.enqueue(new TextEncoder().encode(`data: {"type":"done","text":"${tokenText}","history_saved":true}\n\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function sseStatsResponse(): Response {
  const stats = {
    duration_ms: 8400,
    llm_ms: 7200,
    output_tokens: 240,
    tokens_per_second: 33.3,
    lanes: {
      brain: { calls: 1, duration_ms: 3100, model: 'opencode-go/deepseek-v4.1-flash' },
      talk: { calls: 1, duration_ms: 2600, model: 'opencode/qwen3.8-27b', output_tokens: 240 },
    },
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"token","text":"готово"}\n\n'));
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'done', text: 'готово', turn_stats: stats, history_saved: true })}\n\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function sseErrorResponse(message = 'Ошибка обработки'): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: {"type":"error","code":"chat_error","message":"${message}"}\n\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('ChatView conversation', () => {
  it('sends one chat_id for every message of the same conversation and scopes key to user (AR-11)', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => sseResponse());
    stubFetch(fetchMock);
    render(<ChatView user={{ id: 'u1', email: 'a@example.com', name: 'Аня', role: 'user' }} />);

    const input = screen.getByPlaceholderText(ru.placeholder);
    for (const text of ['первое', 'второе']) {
      fireEvent.change(input, { target: { value: text } });
      fireEvent.submit(input.closest('form')!);
      await waitFor(() => expect(chatPosts(fetchMock)).toHaveLength(text === 'первое' ? 1 : 2));
      await waitFor(() => expect(screen.queryByText('Нейра думает…')).toBeNull());
    }

    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies).toHaveLength(2);
    expect(bodies[0].chat_id).toBeTruthy();
    expect(bodies[1].chat_id).toBe(bodies[0].chat_id);
    expect(sessionStorage.getItem(`neyra.chat_id:u1:${resolveTabKey(window)}`)).toBe(bodies[0].chat_id);

    const stored = JSON.parse(
      window.localStorage.getItem(`neyra:thread-messages:u1:${bodies[0].chat_id}`) || '[]',
    ) as { synced?: boolean }[];
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.every((item) => item.synced === true)).toBe(true);
    window.localStorage.removeItem(`neyra:thread-messages:u1:${bodies[0].chat_id}`);
    window.localStorage.removeItem(`neyra:threads:u1`);
  });

  it('shows per-turn timing and expands the lane breakdown after done', async () => {
    const fetchMock = vi.fn(async () => sseStatsResponse());
    stubFetch(fetchMock);
    render(<ChatView user={{ id: 'u1', email: 'a@example.com', name: 'Аня', role: 'user' }} />);

    const input = screen.getByPlaceholderText(ru.placeholder);
    fireEvent.change(input, { target: { value: 'покажи статистику' } });
    fireEvent.submit(input.closest('form')!);
    expect(await screen.findByText('8,4 с')).toBeTruthy();
    expect(screen.getByText('33,3 ток/с')).toBeTruthy();
    fireEvent.click(screen.getByText('Использовано'));
    expect(screen.getByText('Deepseek V4.1 Flash')).toBeTruthy();
    expect(screen.getByText('Qwen3.8 27b')).toBeTruthy();
    expect(screen.getByText('Мозг')).toBeTruthy();
    expect(screen.getByText('Разговор')).toBeTruthy();
  });

  it('drops corrupt stats from localStorage instead of crashing the chat', async () => {
    const chatId = resolveChatId(sessionStorage, resolveTabKey(window), 'u1');
    const key = `neyra:thread-messages:u1:${chatId}`;
    localStorage.setItem(key, JSON.stringify([
      { id: 'old', role: 'assistant', content: 'старый ответ', stats: { lanes: null } },
    ]));
    const fetchMock = vi.fn(async () => sseResponse());
    stubFetch(fetchMock);
    try {
      render(<ChatView user={{ id: 'u1', email: 'a@example.com', name: 'Аня', role: 'user' }} />);
      expect(await screen.findByText('старый ответ')).toBeTruthy();
      expect(screen.queryByText('Использовано')).toBeNull();
    } finally {
      localStorage.removeItem(key);
    }
  });

  it('opens a new thread in a tab that inherited sessionStorage (AR-11)', async () => {
    sessionStorage.setItem('neyra.chat_id:u1:opener-tab', 'old-thread');
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => sseResponse());
    stubFetch(fetchMock);
    render(<ChatView user={{ id: 'u1', email: 'a@example.com', name: 'Аня', role: 'user' }} />);

    const input = screen.getByPlaceholderText(ru.placeholder);
    fireEvent.change(input, { target: { value: 'новая вкладка' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(chatPosts(fetchMock)).toHaveLength(1));

    const body = JSON.parse(String(chatPosts(fetchMock)[0][1]?.body));
    expect(body.chat_id).toBeTruthy();
    expect(body.chat_id).not.toBe('old-thread');
  });

  it('removes empty assistant message bubble when stream emits error before any token (AR-7)', async () => {
    const fetchMock = vi.fn(async () => sseErrorResponse('Сервер перегружен'));
    stubFetch(fetchMock);
    render(<ChatView user={{ id: 'u1', email: 'a@example.com', name: 'Аня', role: 'user' }} />);

    const input = screen.getByPlaceholderText(ru.placeholder);
    fireEvent.change(input, { target: { value: 'привет с ошибкой' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Сервер перегружен'));
    // Assistant message bubble should not render header/content, leaving only user message and alert block
    expect(screen.queryByText('…')).toBeNull();
    expect(screen.queryByText('Нейра')).toBeNull();
    expect(screen.getAllByText('привет с ошибкой').length).toBeGreaterThan(0);
  });

  it('retrying failed exchange reuses chat_id and replaces error block without adding duplicate user message (§4.1)', async () => {
    let callCount = 0;
    const fetchMock = vi.fn(async () => {
      callCount++;
      if (callCount === 1) return sseErrorResponse('Сбой сети');
      return sseResponse('Успешный ответ после повтора');
    });
    stubFetch(fetchMock);

    render(<ChatView user={{ id: 'u1', email: 'a@example.com', name: 'Аня', role: 'user' }} />);
    const input = screen.getByPlaceholderText(ru.placeholder);
    fireEvent.change(input, { target: { value: 'запрос на повтор' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByText('Сбой сети')).toBeTruthy();

    // Подписи «Вы» больше нет: фиксируем число вхождений текста до и после повтора,
    // чтобы поймать дубль сообщения.
    const beforeRetry = screen.getAllByText('запрос на повтор').length;

    // Click "Повторить"
    const retryBtn = screen.getByText('Повторить');
    fireEvent.click(retryBtn);

    // Check successful response replaced the error block
    await waitFor(() => expect(screen.getByText('Успешный ответ после повтора')).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();

    // There must still be the same number of user message blocks (no duplicate!)
    expect(screen.getAllByText('запрос на повтор').length).toBe(beforeRetry);
    expect(screen.getAllByText('запрос на повтор').length).toBeGreaterThanOrEqual(1);
  });

  it('deleting failed exchange removes both error alert and user message (§4.1)', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      sseErrorResponse('Неисправимая ошибка'),
    );
    stubFetch(fetchMock);

    render(<ChatView user={{ id: 'u1', email: 'a@example.com', name: 'Аня', role: 'user' }} />);
    const input = screen.getByPlaceholderText(ru.placeholder);
    fireEvent.change(input, { target: { value: 'ошибочное сообщение' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getAllByText('ошибочное сообщение').length).toBeGreaterThanOrEqual(1);

    // Click "Удалить"
    const deleteBtn = screen.getByText('Удалить');
    fireEvent.click(deleteBtn);

    // Both error alert and user message should be gone
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.queryByText('ошибочное сообщение')).toBeNull();
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url).includes('/messages/') &&
            (init as RequestInit | undefined)?.method === 'DELETE',
        ),
      ).toBe(true),
    );
  });

  it('clicking "Новый чат" resets messages and issues a fresh chat_id (AR-12)', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => sseResponse());
    stubFetch(fetchMock);
    render(<ChatView user={{ id: 'u1', email: 'a@example.com', name: 'Аня', role: 'user' }} />);

    const input = screen.getByPlaceholderText(ru.placeholder);
    fireEvent.change(input, { target: { value: 'первый чат' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(screen.getByText('привет')).toBeTruthy());

    const firstBody = JSON.parse(String(chatPosts(fetchMock)[0][1]?.body));
    const firstChatId = firstBody.chat_id;

    // Click "Новый чат"
    const newChatBtn = screen.getByText('Новый чат');
    fireEvent.click(newChatBtn);

    // Messages should be cleared
    expect(screen.queryByText('привет')).toBeNull();
    expect(screen.getByText(ru.emptyChat)).toBeTruthy();

    // Next message uses fresh chat_id
    fireEvent.change(input, { target: { value: 'второй чат' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(chatPosts(fetchMock)).toHaveLength(2));

    const secondBody = JSON.parse(String(chatPosts(fetchMock)[1][1]?.body));
    expect(secondBody.chat_id).toBeTruthy();
    expect(secondBody.chat_id).not.toBe(firstChatId);
  });

  it('aborts the request when the page unmounts mid-answer', async () => {
    let aborted = false;
    stubFetch(vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => { aborted = true; reject(new DOMException('aborted', 'AbortError')); });
    })));
    const view = render(<ChatView user={{ id: 'u1', email: 'a@example.com', name: 'Аня', role: 'user' }} />);
    const input = screen.getByPlaceholderText(ru.placeholder);
    fireEvent.change(input, { target: { value: 'долгий ответ' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(screen.getByText('Нейра думает…')).toBeTruthy());
    view.unmount();
    await waitFor(() => expect(aborted).toBe(true));
  });

  it('renders profile popover with user role and settings when user card is clicked (§5.1)', async () => {
    render(<ChatView user={{ id: 'u1', email: 'admin@example.com', name: 'Admin', role: 'admin' }} />);

    const userCard = screen.getByLabelText('Меню профиля пользователя');
    fireEvent.click(userCard);

    // Profile menu should open
    const menu = screen.getByRole('menu', { name: 'Меню профиля' });
    expect(menu).toBeTruthy();
    expect(within(menu).getByText('Настройки')).toBeTruthy();
    expect(within(menu).getByText('Админ-панель')).toBeTruthy();
    expect(within(menu).getByText(ru.signOut)).toBeTruthy();
  });

  it('preserves full thread title for CSS truncation and does not slice without ellipsis (§2)', async () => {
    const longPrompt = 'Расскажи про архитектуру и принципы работы распределённой системы';
    const fetchMock = vi.fn(async () => sseResponse('готово'));
    stubFetch(fetchMock);

    render(<ChatView user={{ id: 'u1', email: 'a@example.com', name: 'Аня', role: 'user' }} />);
    const input = screen.getByPlaceholderText(ru.placeholder);
    fireEvent.change(input, { target: { value: longPrompt } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => expect(screen.getByText('готово')).toBeTruthy());

    // The header h1 should retain the full string (or first line) and have truncate class, not be hard-sliced at 32 chars
    const headerTitle = screen.getByRole('heading', { level: 1 });
    expect(headerTitle.textContent).toBe(longPrompt);
    expect(headerTitle.className).toContain('truncate');
    expect(headerTitle.className).toContain('min-w-0');
  });

  it('hides ContextIndicator when usage is absent and displays it without manual compact button when provided (§5.2)', async () => {
    // 1. Initial render without usage
    const view1 = render(<ChatView user={{ id: 'u1', email: 'a@example.com', name: 'Аня', role: 'user' }} />);
    expect(screen.queryByRole('button', { name: /контекст диалога/i })).toBeNull();
    view1.unmount();

    // 2. Render with initialUsage (without policy)
    const view2 = render(
      <ChatView
        user={{ id: 'u1', email: 'a@example.com', name: 'Аня', role: 'user' }}
        initialUsage={{
          total: { used: 120000, limit: 1000000 },
          lanes: {
            brain: { used: 50000, limit: 500000 },
            talk: { used: 40000, limit: 250000 },
            vision: { used: 15000, limit: 150000 },
            memory: { used: 15000, limit: 100000 },
          },
        }}
      />
    );

    const indicatorBtn = screen.getByRole('button', { name: /контекст диалога/i });
    expect(indicatorBtn).toBeTruthy();
    expect(indicatorBtn.textContent).toContain('12%');

    // Open popover
    fireEvent.click(indicatorBtn);
    expect(screen.getByText('Лейны контекста')).toBeTruthy();
    expect(screen.queryByText('Сжать сейчас')).toBeNull();
    expect(screen.queryByText(/автосжати/i)).toBeNull();
    view2.unmount();

    // 3. Render with compaction_enabled=false policy
    render(
      <ChatView
        user={{ id: 'u1', email: 'a@example.com', name: 'Аня', role: 'user' }}
        initialUsage={{
          total: { used: 120000, limit: 1000000 },
          policy: { compaction_enabled: false },
          lanes: {
            brain: { used: 50000, limit: 500000 },
            talk: { used: 40000, limit: 250000 },
            vision: { used: 15000, limit: 150000 },
            memory: { used: 15000, limit: 100000 },
          },
        }}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /контекст диалога/i }));
    expect(screen.getByText('Автосжатие выключено')).toBeTruthy();
  });

  it('restores thread messages from localStorage upon reload and switches threads (AR-12)', async () => {
    const userId = 'u-persist';
    const tabKey = resolveTabKey(window);
    const thread1Id = 'th-persisted-1';
    const thread2Id = 'th-persisted-2';

    // Simulate active tab having thread1Id
    sessionStorage.setItem(`neyra.chat_id:${userId}:${tabKey}`, thread1Id);

    // Populate threads list and thread messages in localStorage
    window.localStorage.setItem(
      `neyra:threads:${userId}`,
      JSON.stringify([
        { id: thread1Id, title: 'Первый сохранённый тред', updatedAt: '2026-11-13T10:00:00Z' },
        { id: thread2Id, title: 'Второй сохранённый тред', updatedAt: '2026-11-13T11:00:00Z' },
      ])
    );
    window.localStorage.setItem(
      `neyra:thread-messages:${userId}:${thread1Id}`,
      JSON.stringify([
        { id: 'm1', role: 'user', content: 'Сообщение из первого треда' },
        { id: 'm2', role: 'assistant', content: 'Ответ первого треда' },
      ])
    );
    window.localStorage.setItem(
      `neyra:thread-messages:${userId}:${thread2Id}`,
      JSON.stringify([
        { id: 'm3', role: 'user', content: 'Сообщение из второго треда' },
        { id: 'm4', role: 'assistant', content: 'Ответ второго треда' },
      ])
    );

    const { unmount } = render(
      <ChatView user={{ id: userId, email: 'p@example.com', name: 'Персист', role: 'user' }} />
    );

    // Initial render: messages from thread1 restored!
    expect(screen.getAllByText('Сообщение из первого треда').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Ответ первого треда')).toBeTruthy();

    // Switch to thread 2 from sidebar (локальные треды подмешиваются после reconcile)
    fireEvent.click(await screen.findByText('Второй сохранённый тред'));

    // Messages from thread 2 displayed!
    expect(screen.getAllByText('Сообщение из второго треда').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Ответ второго треда')).toBeTruthy();
    expect(screen.queryByText('Ответ первого треда')).toBeNull();

    unmount();
  });

  it('opens and closes right thread panel via header button and remembers open state in localStorage', () => {
    const userId = 'u-panel-test';
    const { unmount } = render(
      <ChatView user={{ id: userId, email: 'panel@example.com', name: 'Панель', role: 'user' }} />
    );

    const toggleBtn = screen.getByRole('button', { name: 'Панель треда' });
    expect(toggleBtn).toBeTruthy();
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('false');

    // Click to open panel
    fireEvent.click(toggleBtn);
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('true');
    expect(window.localStorage.getItem('neyra:thread-panel-open')).toBe('1');
    expect(screen.getByTestId('thread-panel')).toBeTruthy();
    expect(screen.getByText('Панель треда')).toBeTruthy();

    // Close via close button in panel
    const closeBtn = screen.getByRole('button', { name: 'Закрыть панель треда' });
    fireEvent.click(closeBtn);
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('false');
    expect(window.localStorage.getItem('neyra:thread-panel-open')).toBe('0');

    unmount();

    // Remount with localStorage = '1' -> panel is open initially
    window.localStorage.setItem('neyra:thread-panel-open', '1');
    const remount = render(
      <ChatView user={{ id: userId, email: 'panel@example.com', name: 'Панель', role: 'user' }} />
    );
    const remountToggleBtn = screen.getByRole('button', { name: 'Панель треда' });
    expect(remountToggleBtn.getAttribute('aria-expanded')).toBe('true');

    // Close on Escape key
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(remountToggleBtn.getAttribute('aria-expanded')).toBe('false');
    expect(window.localStorage.getItem('neyra:thread-panel-open')).toBe('0');

    remount.unmount();
  });

  it('does not reopen the thread panel from localStorage on a phone', () => {
    const userId = 'u-panel-mobile';
    window.localStorage.setItem('neyra:thread-panel-open', '1');
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
      matches: query === '(max-width: 1023px)',
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    })));
    const { unmount } = render(
      <ChatView user={{ id: userId, email: 'mobile@example.com', name: 'Моб', role: 'user' }} />
    );
    const toggleBtn = screen.getByRole('button', { name: 'Панель треда' });
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('false');
    unmount();
    window.localStorage.clear();
  });

  it('uploads a selected file and sends only the stored attachment metadata (AR-14)', async () => {
    const stored = { id: 'b'.repeat(32), kind: 'file', mime: 'text/plain', name: 'doc.txt', size: 5 };
    const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      if (String(url) === '/api/attachments') {
        return new Response(JSON.stringify({ attachments: [stored] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return sseResponse('ок');
    });
    stubFetch(fetchMock);
    const { container } = render(
      <ChatView user={{ id: 'u-att', email: 'att@example.com', name: 'Атт', role: 'user' }} />
    );

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, {
      target: { files: [new File(['hello'], 'doc.txt', { type: 'text/plain' })] },
    });
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url) === '/api/attachments')).toBe(true));
    expect(await screen.findByText('doc.txt')).toBeTruthy();

    const input = screen.getByPlaceholderText(ru.placeholder);
    fireEvent.change(input, { target: { value: 'смотри файл' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url) === '/api/chat')).toBe(true));

    const chatCall = fetchMock.mock.calls.find(([url]) => String(url) === '/api/chat')!;
    const body = JSON.parse(String(chatCall[1]?.body));
    expect(body.attachments).toEqual([stored]);
    expect(body.text).toBe('смотри файл');
  });

  it('clears attachments and usage when switching to another thread (AR-24)', async () => {
    const userId = 'u-switch';
    const tabKey = resolveTabKey(window);
    const thread1Id = 'th-switch-1';
    const thread2Id = 'th-switch-2';
    sessionStorage.setItem(`neyra.chat_id:${userId}:${tabKey}`, thread1Id);
    window.localStorage.setItem(`neyra:threads:${userId}`, JSON.stringify([
      { id: thread1Id, title: 'Первый тред', updatedAt: '2026-11-14T10:00:00Z' },
      { id: thread2Id, title: 'Второй тред', updatedAt: '2026-11-14T11:00:00Z' },
    ]));
    window.localStorage.setItem(`neyra:thread-messages:${userId}:${thread1Id}`, JSON.stringify([
      { id: 'm1', role: 'user', content: 'Первый вопрос' },
      { id: 'm2', role: 'assistant', content: 'Первый ответ' },
    ]));
    window.localStorage.setItem(`neyra:thread-messages:${userId}:${thread2Id}`, JSON.stringify([
      { id: 'm3', role: 'user', content: 'Второй вопрос' },
      { id: 'm4', role: 'assistant', content: 'Второй ответ' },
    ]));

    const stored = { id: 'c'.repeat(32), kind: 'file', mime: 'text/plain', name: 'switch.txt', size: 5 };
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === '/api/attachments') {
        return new Response(JSON.stringify({ attachments: [stored] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return sseResponse('ок');
    });
    stubFetch(fetchMock);
    const { container } = render(
      <ChatView
        user={{ id: userId, email: 'switch@example.com', name: 'Свитч', role: 'user' }}
        initialUsage={{ total: { used: 10, limit: 100 } }}
      />
    );

    expect(screen.getByRole('button', { name: /контекст диалога/i })).toBeTruthy();
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, {
      target: { files: [new File(['hello'], 'switch.txt', { type: 'text/plain' })] },
    });
    expect(await screen.findByText('switch.txt')).toBeTruthy();

    fireEvent.click(screen.getByText('Второй тред'));

    expect(screen.queryByText('switch.txt')).toBeNull();
    expect(screen.queryByRole('button', { name: /контекст диалога/i })).toBeNull();
    expect(screen.getByText('Второй ответ')).toBeTruthy();
  });

  it('does not attach an upload that finished after the thread changed (AR-24)', async () => {
    const userId = 'u-upload-switch';
    const tabKey = resolveTabKey(window);
    const thread1Id = 'th-upload-1';
    const thread2Id = 'th-upload-2';
    sessionStorage.setItem(`neyra.chat_id:${userId}:${tabKey}`, thread1Id);
    window.localStorage.setItem(`neyra:threads:${userId}`, JSON.stringify([
      { id: thread1Id, title: 'Старый тред', updatedAt: '2026-11-14T10:00:00Z' },
      { id: thread2Id, title: 'Новый тред', updatedAt: '2026-11-14T11:00:00Z' },
    ]));

    let resolveUpload: ((response: Response) => void) | undefined;
    const uploadPromise = new Promise<Response>((resolve) => { resolveUpload = resolve; });
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === '/api/attachments') return uploadPromise;
      return sseResponse('ок');
    });
    stubFetch(fetchMock);
    const { container } = render(
      <ChatView user={{ id: userId, email: 'late@example.com', name: 'Поздний', role: 'user' }} />
    );

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, {
      target: { files: [new File(['hello'], 'late.txt', { type: 'text/plain' })] },
    });
    await waitFor(() => expect(screen.getByText('Загружаю вложение…')).toBeTruthy());

    fireEvent.click(screen.getByText('Новый тред'));
    resolveUpload?.(new Response(JSON.stringify({
      attachments: [{ id: 'd'.repeat(32), kind: 'file', mime: 'text/plain', name: 'late.txt', size: 5 }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await waitFor(() => expect(screen.queryByText('Загружаю вложение…')).toBeNull());
    expect(screen.queryByText('late.txt')).toBeNull();
  });

  it('drops old-format attachments when retrying a failed answer (AR-24)', async () => {
    const userId = 'u-retry-legacy';
    const tabKey = resolveTabKey(window);
    const threadId = 'th-retry-legacy';
    sessionStorage.setItem(`neyra.chat_id:${userId}:${tabKey}`, threadId);
    window.localStorage.setItem(`neyra:threads:${userId}`, JSON.stringify([
      { id: threadId, title: 'Старый тред', updatedAt: '2026-11-14T10:00:00Z' },
    ]));
    window.localStorage.setItem(`neyra:thread-messages:${userId}:${threadId}`, JSON.stringify([
      {
        id: 'u-old',
        role: 'user',
        content: 'Старый вопрос',
        attachments: [{ id: crypto.randomUUID(), name: 'old.txt', size: 5, isImage: false }],
      },
      { id: 'a-old', role: 'assistant', content: '', error: 'Сеть недоступна' },
    ]));

    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => sseResponse('ответ'));
    stubFetch(fetchMock);
    render(<ChatView user={{ id: userId, email: 'retry@example.com', name: 'Ретрай', role: 'user' }} />);

    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    await waitFor(() => expect(chatPosts(fetchMock)).toHaveLength(1));

    const body = JSON.parse(String(chatPosts(fetchMock)[0][1]?.body));
    expect(body.text).toBe('Старый вопрос');
    expect(body.attachments).toBeUndefined();
    expect(body.retry).toBe(true);
    expect(body.assistant_message_id).toBe('a-old');
    expect(body.user_message_id).toBe('u-old');
  });

  it('pins message from message action button and syncs to localStorage and thread panel', () => {
    const userId = 'u-pin-test';
    const threadId = 'th-pin-1';
    const tabKey = resolveTabKey(window);
    sessionStorage.setItem(`neyra.chat_id:${userId}:${tabKey}`, threadId);

    window.localStorage.setItem(
      `neyra:thread-messages:${userId}:${threadId}`,
      JSON.stringify([
        { id: 'm-pinned-1', role: 'assistant', content: 'Ответ с важной информацией' },
      ])
    );

    const { unmount } = render(
      <ChatView user={{ id: userId, email: 'pin@example.com', name: 'Пин', role: 'user' }} />
    );

    // Message is rendered
    expect(screen.getByText('Ответ с важной информацией')).toBeTruthy();

    // Pin button on message
    const pinBtn = screen.getByRole('button', { name: 'Закрепить сообщение' });
    expect(pinBtn).toBeTruthy();
    fireEvent.click(pinBtn);

    // Stored in localStorage
    const savedPins = JSON.parse(window.localStorage.getItem(`neyra:pinned-messages:${userId}:${threadId}`) || '[]');
    expect(savedPins).toContain('m-pinned-1');

    // Button label now indicates unpin
    expect(screen.getByRole('button', { name: 'Открепить сообщение' })).toBeTruthy();

    // Open thread panel and switch to pinned tab
    fireEvent.click(screen.getByRole('button', { name: 'Панель треда' }));
    fireEvent.click(screen.getByRole('tab', { name: /Закреплённые/ }));

    // Message snippet is shown in pinned list inside panel
    expect(screen.getAllByText('Ответ с важной информацией').length).toBeGreaterThanOrEqual(2);

    unmount();
  });

  it('loads the tab thread messages and server threads from the BFF', async () => {
    const userId = 'hist-user';
    const chatId = resolveChatId(sessionStorage, resolveTabKey(window), userId);
    window.localStorage.setItem(
      `neyra:thread-messages:${userId}:${chatId}`,
      JSON.stringify([{ id: 'stale', role: 'user', content: 'локальная копия', synced: true }]),
    );
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href === '/api/conversations?limit=100') {
        return new Response(
          JSON.stringify({
            ok: true,
            data: { items: [{ id: chatId, title: 'Серверный тред', updatedAt: '2026-11-20T10:00:00Z' }] },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (href.startsWith(`/api/conversations/${chatId}?`)) {
        return new Response(
          JSON.stringify({
            ok: true,
            data: {
              messages: [
                { id: 's1', role: 'user', content: 'вопрос из базы', status: 'done' },
                { id: 's2', role: 'assistant', content: 'ответ из базы', status: 'done' },
              ],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return sseResponse();
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ChatView user={{ id: userId, email: 'hist@example.com', name: 'История', role: 'user' }} />);

    expect(await screen.findByText('ответ из базы')).toBeTruthy();
    expect(screen.queryByText('локальная копия')).toBeNull();
    expect(await screen.findByRole('button', { name: 'Серверный тред' })).toBeTruthy();

    window.localStorage.removeItem(`neyra:thread-messages:${userId}:${chatId}`);
  });

  it('renames the thread on the server from the thread panel', async () => {
    const userId = 'rename-user';
    const chatId = resolveChatId(sessionStorage, resolveTabKey(window), userId);
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href === '/api/conversations?limit=100') {
        return new Response(
          JSON.stringify({
            ok: true,
            data: { items: [{ id: chatId, title: 'Старое имя', updatedAt: '2026-11-20T10:00:00Z' }] },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (href === `/api/conversations/${chatId}` && init?.method === 'PATCH') {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (href.startsWith(`/api/conversations/${chatId}?`)) {
        return new Response(JSON.stringify({ ok: true, data: { messages: [] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return sseResponse();
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <ChatView
        user={{ id: userId, email: 'rename@example.com', name: 'Имя', role: 'user' }}
        initialThreadPanelOpen
      />,
    );
    expect(await screen.findByText('Старое имя')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Переименовать диалог' }));
    fireEvent.change(screen.getByLabelText('Название темы'), { target: { value: 'Новое имя' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url) === `/api/conversations/${chatId}` &&
            (init as RequestInit | undefined)?.method === 'PATCH' &&
            String((init as RequestInit).body).includes('Новое имя'),
        ),
      ).toBe(true),
    );
  });

  it('archives a thread on the server when it is deleted from the sidebar', async () => {
    const userId = 'delete-user';
    const chatId = resolveChatId(sessionStorage, resolveTabKey(window), userId);
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href === '/api/conversations?limit=100') {
        return new Response(
          JSON.stringify({
            ok: true,
            data: { items: [{ id: chatId, title: 'Удаляемый тред', updatedAt: '2026-11-20T10:00:00Z' }] },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (href === `/api/conversations/${chatId}` && init?.method === 'DELETE') {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (href.startsWith(`/api/conversations/${chatId}?`)) {
        return new Response(JSON.stringify({ ok: true, data: { messages: [] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return sseResponse();
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ChatView user={{ id: userId, email: 'del@example.com', name: 'Удаление', role: 'user' }} />);
    await screen.findByText('Удаляемый тред');

    fireEvent.click(screen.getByLabelText('Удалить Удаляемый тред'));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url) === `/api/conversations/${chatId}` &&
            (init as RequestInit | undefined)?.method === 'DELETE',
        ),
      ).toBe(true),
    );
    await waitFor(() => expect(screen.queryByText('Удаляемый тред')).toBeNull());
  });

  it('takes the server list as the base and migrates legacy pins', async () => {
    const userId = 'merge-user';
    const chatId = resolveChatId(sessionStorage, resolveTabKey(window), userId);
    const stats = {
      duration_ms: 8400,
      llm_ms: 7200,
      output_tokens: 240,
      tokens_per_second: 33.3,
      lanes: {
        brain: { calls: 1, duration_ms: 3100, model: 'opencode-go/deepseek-v4.1-flash' },
        talk: { calls: 1, duration_ms: 2600, model: 'opencode/qwen3.8-27b', output_tokens: 240 },
      },
    };
    window.localStorage.setItem(
      `neyra:thread-messages:${userId}:${chatId}`,
      JSON.stringify([
        { id: 'local-user', role: 'user', content: 'вопрос' },
        { id: 'local-assistant', role: 'assistant', content: 'ответ', stats },
      ]),
    );
    window.localStorage.setItem(
      `neyra:pinned-messages:${userId}:${chatId}`,
      JSON.stringify(['local-assistant']),
    );
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href === '/api/conversations?limit=100') {
        return new Response(
          JSON.stringify({ ok: true, data: { items: [{ id: chatId, title: 'Тред', updatedAt: '2026-11-20T10:00:00Z' }] } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (href.startsWith(`/api/conversations/${chatId}?`)) {
        return new Response(
          JSON.stringify({
            ok: true,
            data: {
              messages: [
                { id: 'srv-user', role: 'user', content: 'вопрос', status: 'done' },
                { id: 'srv-assistant', role: 'assistant', content: 'ответ', status: 'done' },
              ],
              total: 2,
              has_more: false,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return sseResponse();
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ChatView user={{ id: userId, email: 'merge@example.com', name: 'Мерж', role: 'user' }} />);

    expect(await screen.findByText('8,4 с')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Открепить сообщение' })).toBeTruthy();
    expect(
      window.localStorage.getItem(`neyra:pinned-messages:${userId}:${chatId}`),
    ).toBe(JSON.stringify(['srv-assistant']));

    window.localStorage.removeItem(`neyra:thread-messages:${userId}:${chatId}`);
    window.localStorage.removeItem(`neyra:pinned-messages:${userId}:${chatId}`);
    window.localStorage.removeItem(`neyra:threads:${userId}`);
  });

  it('applies a deletion made on another device instead of trusting a longer cache', async () => {
    const userId = 'remote-delete-user';
    const chatId = resolveChatId(sessionStorage, resolveTabKey(window), userId);
    window.localStorage.setItem(
      `neyra:thread-messages:${userId}:${chatId}`,
      JSON.stringify([
        { id: 'u1', role: 'user', content: 'первый вопрос', synced: true },
        { id: 'a1', role: 'assistant', content: 'первый ответ', synced: true },
        { id: 'u2', role: 'user', content: 'удалённый вопрос', synced: true },
        { id: 'a2', role: 'assistant', content: 'удалённый ответ', synced: true },
      ]),
    );
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href === '/api/conversations?limit=100') {
        return new Response(
          JSON.stringify({ ok: true, data: { items: [{ id: chatId, title: 'Тред', updatedAt: '2026-11-20T10:00:00Z' }] } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (href.startsWith(`/api/conversations/${chatId}?`)) {
        return new Response(
          JSON.stringify({
            ok: true,
            data: {
              messages: [
                { id: 'u1', role: 'user', content: 'первый вопрос', status: 'done' },
                { id: 'a1', role: 'assistant', content: 'первый ответ', status: 'done' },
              ],
              total: 2,
              has_more: false,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return sseResponse();
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ChatView user={{ id: userId, email: 'rd@example.com', name: 'РД', role: 'user' }} />);

    expect(await screen.findByText('первый ответ')).toBeTruthy();
    expect(screen.queryByText('удалённый вопрос')).toBeNull();
    expect(screen.queryByText('удалённый ответ')).toBeNull();
    window.localStorage.removeItem(`neyra:thread-messages:${userId}:${chatId}`);
    window.localStorage.removeItem(`neyra:threads:${userId}`);
  });

  it('keeps a turn whose history write failed (synced: false)', async () => {
    const userId = 'unsynced-user';
    const chatId = resolveChatId(sessionStorage, resolveTabKey(window), userId);
    window.localStorage.setItem(
      `neyra:thread-messages:${userId}:${chatId}`,
      JSON.stringify([
        { id: 'u1', role: 'user', content: 'старый вопрос', synced: true },
        { id: 'a1', role: 'assistant', content: 'старый ответ', synced: true },
        { id: 'u2', role: 'user', content: 'несохранённый вопрос', synced: false },
        { id: 'a2', role: 'assistant', content: 'несохранённый ответ', synced: false },
      ]),
    );
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href === '/api/conversations?limit=100') {
        return new Response(
          JSON.stringify({ ok: true, data: { items: [{ id: chatId, title: 'Тред', updatedAt: '2026-11-20T10:00:00Z' }] } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (href.startsWith(`/api/conversations/${chatId}?`)) {
        return new Response(
          JSON.stringify({
            ok: true,
            data: {
              messages: [
                { id: 'u1', role: 'user', content: 'старый вопрос', status: 'done' },
                { id: 'a1', role: 'assistant', content: 'старый ответ', status: 'done' },
              ],
              total: 2,
              has_more: false,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return sseResponse();
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ChatView user={{ id: userId, email: 'un@example.com', name: 'Ан', role: 'user' }} />);
    expect(await screen.findByText('несохранённый ответ')).toBeTruthy();
    const saved = JSON.parse(
      window.localStorage.getItem(`neyra:thread-messages:${userId}:${chatId}`) || '[]',
    ) as { id: string; synced?: boolean }[];
    expect(saved.find((item) => item.id === 'u2')?.synced).toBe(false);
    window.localStorage.removeItem(`neyra:thread-messages:${userId}:${chatId}`);
    window.localStorage.removeItem(`neyra:threads:${userId}`);
  });

  it('keeps an unsynced 502 exchange even when another device added a newer turn', async () => {
    const userId = 'unsynced-remote-user';
    const chatId = resolveChatId(sessionStorage, resolveTabKey(window), userId);
    window.localStorage.setItem(
      `neyra:thread-messages:${userId}:${chatId}`,
      JSON.stringify([
        { id: 'u1', role: 'user', content: 'первый вопрос', synced: true },
        { id: 'a1', role: 'assistant', content: 'первый ответ', synced: true },
        { id: 'err-u', role: 'user', content: 'вопрос с 502', synced: false },
        { id: 'err-a', role: 'assistant', content: 'ядро недоступно', error: 'core_unavailable', synced: false },
      ]),
    );
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href === '/api/conversations?limit=100') {
        return new Response(
          JSON.stringify({ ok: true, data: { items: [{ id: chatId, title: 'Тред', updatedAt: '2026-11-20T10:00:00Z' }] } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (href.startsWith(`/api/conversations/${chatId}?`)) {
        return new Response(
          JSON.stringify({
            ok: true,
            data: {
              messages: [
                { id: 'u1', role: 'user', content: 'первый вопрос', status: 'done' },
                { id: 'a1', role: 'assistant', content: 'первый ответ', status: 'done' },
                { id: 'uB', role: 'user', content: 'вопрос с ПК B', status: 'done' },
                { id: 'aB', role: 'assistant', content: 'ответ с ПК B', status: 'done' },
              ],
              total: 4,
              has_more: false,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return sseResponse();
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ChatView user={{ id: userId, email: 'ur@example.com', name: 'УР', role: 'user' }} />);
    expect(await screen.findByText('ответ с ПК B')).toBeTruthy();
    expect(screen.getByText('вопрос с 502')).toBeTruthy();
    expect(screen.getByRole('alert')).toBeTruthy();
    window.localStorage.removeItem(`neyra:thread-messages:${userId}:${chatId}`);
    window.localStorage.removeItem(`neyra:threads:${userId}`);
  });

  it('clears synced local messages when the thread is empty on the server', async () => {
    const userId = 'emptied-user';
    const chatId = resolveChatId(sessionStorage, resolveTabKey(window), userId);
    window.localStorage.setItem(
      `neyra:thread-messages:${userId}:${chatId}`,
      JSON.stringify([
        { id: 'u1', role: 'user', content: 'удалённое сообщение', synced: true },
        { id: 'a1', role: 'assistant', content: 'удалённый ответ', synced: true },
      ]),
    );
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href === '/api/conversations?limit=100') {
        return new Response(
          JSON.stringify({ ok: true, data: { items: [{ id: chatId, title: 'Тред', updatedAt: '2026-11-20T10:00:00Z' }] } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (href.startsWith(`/api/conversations/${chatId}?`)) {
        return new Response(
          JSON.stringify({ ok: true, data: { messages: [], total: 0, has_more: false } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return sseResponse();
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ChatView user={{ id: userId, email: 'empty@example.com', name: 'Пусто', role: 'user' }} />);
    await waitFor(() => expect(screen.queryByText('удалённый ответ')).toBeNull());
    expect(screen.queryByText('удалённое сообщение')).toBeNull();
    window.localStorage.removeItem(`neyra:thread-messages:${userId}:${chatId}`);
    window.localStorage.removeItem(`neyra:threads:${userId}`);
  });

  it('maps duplicate legacy messages to server ids in order', async () => {
    const userId = 'duplicate-user';
    const chatId = resolveChatId(sessionStorage, resolveTabKey(window), userId);
    window.localStorage.setItem(
      `neyra:thread-messages:${userId}:${chatId}`,
      JSON.stringify([
        { id: 'L1', role: 'user', content: 'продолжи' },
        { id: 'L2', role: 'assistant', content: 'ответ 1' },
        { id: 'L3', role: 'user', content: 'продолжи' },
        { id: 'L4', role: 'assistant', content: 'ответ 2' },
      ]),
    );
    window.localStorage.setItem(
      `neyra:pinned-messages:${userId}:${chatId}`,
      JSON.stringify(['L1', 'L3']),
    );
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href === '/api/conversations?limit=100') {
        return new Response(
          JSON.stringify({ ok: true, data: { items: [{ id: chatId, title: 'Тред', updatedAt: '2026-11-20T10:00:00Z' }] } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (href.startsWith(`/api/conversations/${chatId}?`)) {
        return new Response(
          JSON.stringify({
            ok: true,
            data: {
              messages: [
                { id: 'S1', role: 'user', content: 'продолжи', status: 'done' },
                { id: 'S2', role: 'assistant', content: 'ответ 1', status: 'done' },
                { id: 'S3', role: 'user', content: 'продолжи', status: 'done' },
                { id: 'S4', role: 'assistant', content: 'ответ 2', status: 'done' },
              ],
              total: 4,
              has_more: false,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return sseResponse();
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ChatView user={{ id: userId, email: 'dup@example.com', name: 'Дуп', role: 'user' }} />);
    await waitFor(() =>
      expect(
        window.localStorage.getItem(`neyra:pinned-messages:${userId}:${chatId}`),
      ).toBe(JSON.stringify(['S1', 'S3'])),
    );
    window.localStorage.removeItem(`neyra:thread-messages:${userId}:${chatId}`);
    window.localStorage.removeItem(`neyra:pinned-messages:${userId}:${chatId}`);
    window.localStorage.removeItem(`neyra:threads:${userId}`);
  });

  it('keeps pre-#105 legacy history that has no server counterpart', async () => {
    const userId = 'legacy-history-user';
    const chatId = resolveChatId(sessionStorage, resolveTabKey(window), userId);
    window.localStorage.setItem(
      `neyra:thread-messages:${userId}:${chatId}`,
      JSON.stringify([
        { id: 'L1', role: 'user', content: 'старый вопрос 1' },
        { id: 'L2', role: 'assistant', content: 'старый ответ 1' },
        { id: 'L3', role: 'user', content: 'старый вопрос 2' },
        { id: 'L4', role: 'assistant', content: 'старый ответ 2' },
      ]),
    );
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href === '/api/conversations?limit=100') {
        return new Response(
          JSON.stringify({ ok: true, data: { items: [{ id: chatId, title: 'Тред', updatedAt: '2026-11-20T10:00:00Z' }] } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (href.startsWith(`/api/conversations/${chatId}?`)) {
        return new Response(
          JSON.stringify({
            ok: true,
            data: {
              messages: [
                { id: 'S5', role: 'user', content: 'новый вопрос', status: 'done' },
                { id: 'S6', role: 'assistant', content: 'новый ответ', status: 'done' },
              ],
              total: 2,
              has_more: false,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return sseResponse();
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ChatView user={{ id: userId, email: 'legacy@example.com', name: 'Легаси', role: 'user' }} />);
    expect(await screen.findByText('новый ответ')).toBeTruthy();
    expect(screen.getByText('старый вопрос 1')).toBeTruthy();
    expect(screen.getByText('старый ответ 2')).toBeTruthy();
    await waitFor(() => {
      const stored = JSON.parse(
        window.localStorage.getItem(`neyra:thread-messages:${userId}:${chatId}`) || '[]',
      ) as { id: string }[];
      expect(stored.map((item) => item.id)).toEqual([
        'L1',
        'L2',
        'L3',
        'L4',
        'S5',
        'S6',
      ]);
    });
    window.localStorage.removeItem(`neyra:thread-messages:${userId}:${chatId}`);
    window.localStorage.removeItem(`neyra:threads:${userId}`);
  });

  it('does not consume an unsynced message as a legacy match', async () => {
    const userId = 'unsynced-match-user';
    const chatId = resolveChatId(sessionStorage, resolveTabKey(window), userId);
    window.localStorage.setItem(
      `neyra:thread-messages:${userId}:${chatId}`,
      JSON.stringify([
        { id: 'UA', role: 'user', content: 'да', synced: false },
        { id: 'AERR', role: 'assistant', content: 'ответ не сохранился', synced: false },
      ]),
    );
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href === '/api/conversations?limit=100') {
        return new Response(
          JSON.stringify({ ok: true, data: { items: [{ id: chatId, title: 'Тред', updatedAt: '2026-11-20T10:00:00Z' }] } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (href.startsWith(`/api/conversations/${chatId}?`)) {
        return new Response(
          JSON.stringify({
            ok: true,
            data: {
              messages: [
                { id: 'SB', role: 'user', content: 'да', status: 'done' },
                { id: 'AB', role: 'assistant', content: 'ответ с сервера', status: 'done' },
              ],
              total: 2,
              has_more: false,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return sseResponse();
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ChatView user={{ id: userId, email: 'um@example.com', name: 'УМ', role: 'user' }} />);
    expect(await screen.findByText('ответ с сервера')).toBeTruthy();
    expect(screen.getByText('ответ не сохранился')).toBeTruthy();
    expect(screen.getAllByText('да').length).toBeGreaterThanOrEqual(2);
    window.localStorage.removeItem(`neyra:thread-messages:${userId}:${chatId}`);
    window.localStorage.removeItem(`neyra:threads:${userId}`);
  });

  it('matches legacy history only once across two syncs', async () => {
    const userId = 'legacy-twice-user';
    const chatId = resolveChatId(sessionStorage, resolveTabKey(window), userId);
    window.localStorage.setItem(
      `neyra:thread-messages:${userId}:${chatId}`,
      JSON.stringify([
        { id: 'L1', role: 'user', content: 'да' },
        { id: 'L2', role: 'assistant', content: 'старый ответ' },
      ]),
    );
    window.localStorage.setItem(
      `neyra:pinned-messages:${userId}:${chatId}`,
      JSON.stringify(['L1']),
    );
    let serverMessages: unknown[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href === '/api/conversations?limit=100') {
        return new Response(
          JSON.stringify({ ok: true, data: { items: [{ id: chatId, title: 'Тред', updatedAt: '2026-11-20T10:00:00Z' }] } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (href.startsWith(`/api/conversations/${chatId}?`)) {
        return new Response(
          JSON.stringify({
            ok: true,
            data: { messages: serverMessages, total: serverMessages.length, has_more: false },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return sseResponse();
    });
    vi.stubGlobal('fetch', fetchMock);

    const first = render(
      <ChatView user={{ id: userId, email: 'twice@example.com', name: 'Дважды', role: 'user' }} />,
    );
    await waitFor(() => {
      const stored = JSON.parse(
        window.localStorage.getItem(`neyra:thread-messages:${userId}:${chatId}`) || '[]',
      ) as { id: string; localOnly?: boolean }[];
      expect(stored.map((item) => [item.id, item.localOnly])).toEqual([
        ['L1', true],
        ['L2', true],
      ]);
    });
    first.unmount();

    serverMessages = [
      { id: 'SB', role: 'user', content: 'да', status: 'done' },
      { id: 'AB', role: 'assistant', content: 'новый ответ', status: 'done' },
    ];
    render(<ChatView user={{ id: userId, email: 'twice@example.com', name: 'Дважды', role: 'user' }} />);
    expect(await screen.findByText('новый ответ')).toBeTruthy();
    expect(screen.getByText('старый ответ')).toBeTruthy();
    expect(screen.getAllByText('да').length).toBeGreaterThanOrEqual(2);
    await waitFor(() => {
      const stored = JSON.parse(
        window.localStorage.getItem(`neyra:thread-messages:${userId}:${chatId}`) || '[]',
      ) as { id: string }[];
      expect(stored.map((item) => item.id)).toEqual(['L1', 'L2', 'SB', 'AB']);
    });
    expect(
      window.localStorage.getItem(`neyra:pinned-messages:${userId}:${chatId}`),
    ).toBe(JSON.stringify(['L1']));
    window.localStorage.removeItem(`neyra:thread-messages:${userId}:${chatId}`);
    window.localStorage.removeItem(`neyra:pinned-messages:${userId}:${chatId}`);
    window.localStorage.removeItem(`neyra:threads:${userId}`);
  });

  it('shows a new thread in the sidebar when chat fails before core hello', async () => {
    const userId = 'http-error-user';
    resolveChatId(sessionStorage, resolveTabKey(window), userId);
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href === '/api/conversations?limit=100') {
        return new Response(JSON.stringify({ ok: true, data: { items: [] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (href.startsWith('/api/conversations/')) {
        return new Response(JSON.stringify({ error: 'not_found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: 'core_unavailable' }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ChatView user={{ id: userId, email: 'http@example.com', name: 'HTTP', role: 'user' }} />);
    const input = screen.getByPlaceholderText(ru.placeholder);
    fireEvent.change(input, { target: { value: 'вопрос до hello' } });
    fireEvent.submit(input.closest('form')!);

    expect(await screen.findByRole('button', { name: 'вопрос до hello' })).toBeTruthy();
    window.localStorage.removeItem(`neyra:threads:${userId}`);
  });

  it('keeps the SSR thread list when the history API is unavailable', async () => {
    const userId = 'unavailable-user';
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.startsWith('/api/conversations')) {
        return new Response(JSON.stringify({ error: 'history_unavailable' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      }
      return sseResponse();
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <ChatView
        user={{ id: userId, email: 'down@example.com', name: 'Даун', role: 'user' }}
        initialThreads={[{ id: 'srv-1', title: 'Серверный тред', updatedAt: '2026-11-20T10:00:00Z' }]}
      />,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.getByText('Серверный тред')).toBeTruthy();
  });

  it('drops a local thread archived on another device', async () => {
    const userId = 'archived-user';
    window.localStorage.setItem(
      `neyra:threads:${userId}`,
      JSON.stringify([{ id: 'archived-thread', title: 'Удалённый на ПК', updatedAt: '2026-11-20T10:00:00Z' }]),
    );
    window.localStorage.setItem(
      `neyra:thread-messages:${userId}:archived-thread`,
      JSON.stringify([{ id: 'm1', role: 'user', content: 'старое' }]),
    );
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href === '/api/conversations?limit=100') {
        return new Response(JSON.stringify({ ok: true, data: { items: [] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (href.startsWith('/api/conversations/archived-thread?')) {
        return new Response(
          JSON.stringify({
            ok: true,
            data: { conversation: { id: 'archived-thread', archivedAt: '2026-11-21T10:00:00Z' } },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return sseResponse();
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ChatView user={{ id: userId, email: 'arch@example.com', name: 'Архив', role: 'user' }} />);

    await waitFor(() =>
      expect(window.localStorage.getItem(`neyra:thread-messages:${userId}:archived-thread`)).toBeNull(),
    );
    expect(screen.queryByText('Удалённый на ПК')).toBeNull();
    window.localStorage.removeItem(`neyra:threads:${userId}`);
  });

  it('does not remove the thread when the archive request fails', async () => {
    const userId = 'archive-fail-user';
    const chatId = resolveChatId(sessionStorage, resolveTabKey(window), userId);
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href === '/api/conversations?limit=100') {
        return new Response(
          JSON.stringify({ ok: true, data: { items: [{ id: chatId, title: 'Живой тред', updatedAt: '2026-11-20T10:00:00Z' }] } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (href === `/api/conversations/${chatId}` && init?.method === 'DELETE') {
        return new Response(JSON.stringify({ error: 'history_unavailable' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (href.startsWith(`/api/conversations/${chatId}?`)) {
        return new Response(JSON.stringify({ ok: true, data: { messages: [], total: 0, has_more: false } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return sseResponse();
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ChatView user={{ id: userId, email: 'fail@example.com', name: 'Фейл', role: 'user' }} />);
    await screen.findByText('Живой тред');
    fireEvent.click(screen.getByLabelText('Удалить Живой тред'));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url) === `/api/conversations/${chatId}` &&
            (init as RequestInit | undefined)?.method === 'DELETE',
        ),
      ).toBe(true),
    );
    expect(screen.getAllByText('Живой тред').length).toBeGreaterThan(0);
  });

  it('archives the thread on clear and starts a fresh chat', async () => {
    const userId = 'clear-user';
    const chatId = resolveChatId(sessionStorage, resolveTabKey(window), userId);
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href === '/api/conversations?limit=100') {
        return new Response(
          JSON.stringify({ ok: true, data: { items: [{ id: chatId, title: 'Тред для очистки', updatedAt: '2026-11-20T10:00:00Z' }] } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (href === `/api/conversations/${chatId}` && init?.method === 'DELETE') {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (href.startsWith(`/api/conversations/${chatId}?`)) {
        return new Response(JSON.stringify({ ok: true, data: { messages: [], total: 0, has_more: false } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return sseResponse();
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <ChatView
        user={{ id: userId, email: 'clear@example.com', name: 'Клир', role: 'user' }}
        initialThreadPanelOpen
      />,
    );
    await screen.findByText('Тред для очистки');
    fireEvent.click(screen.getByRole('button', { name: 'Очистить диалог' }));
    fireEvent.click(screen.getByRole('button', { name: 'Да, очистить' }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url) === `/api/conversations/${chatId}` &&
            (init as RequestInit | undefined)?.method === 'DELETE',
        ),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(sessionStorage.getItem(`neyra.chat_id:${userId}:${resolveTabKey(window)}`)).not.toBe(chatId),
    );
  });

  it('keeps the old thread name when the rename request fails', async () => {
    const userId = 'rename-fail-user';
    const chatId = resolveChatId(sessionStorage, resolveTabKey(window), userId);
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href === '/api/conversations?limit=100') {
        return new Response(
          JSON.stringify({ ok: true, data: { items: [{ id: chatId, title: 'Старое имя', updatedAt: '2026-11-20T10:00:00Z' }] } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (href === `/api/conversations/${chatId}` && init?.method === 'PATCH') {
        return new Response(JSON.stringify({ error: 'history_unavailable' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (href.startsWith(`/api/conversations/${chatId}?`)) {
        return new Response(JSON.stringify({ ok: true, data: { messages: [], total: 0, has_more: false } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return sseResponse();
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <ChatView
        user={{ id: userId, email: 'rf@example.com', name: 'РФ', role: 'user' }}
        initialThreadPanelOpen
      />,
    );
    await screen.findByText('Старое имя');
    fireEvent.click(screen.getByRole('button', { name: 'Переименовать диалог' }));
    fireEvent.change(screen.getByLabelText('Название темы'), { target: { value: 'Новое имя' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url) === `/api/conversations/${chatId}` &&
            (init as RequestInit | undefined)?.method === 'PATCH',
        ),
      ).toBe(true),
    );
    expect(screen.queryByText('Новое имя')).toBeNull();
    expect(screen.getAllByText('Старое имя').length).toBeGreaterThan(0);
  });

  it('shows a thread whose first turn ended with a core error', async () => {
    const userId = 'error-thread-user';
    const chatId = resolveChatId(sessionStorage, resolveTabKey(window), userId);
    let listCalls = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href === '/api/conversations?limit=100') {
        listCalls += 1;
        return new Response(
          JSON.stringify({
            ok: true,
            data: {
              items:
                listCalls === 1
                  ? []
                  : [{ id: chatId, title: 'Тред с ошибкой', updatedAt: '2026-11-20T10:00:00Z' }],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (href.startsWith(`/api/conversations/${chatId}?`)) {
        return new Response(JSON.stringify({ ok: true, data: { messages: [], total: 0, has_more: false } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return sseErrorResponse('Сбой ядра');
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ChatView user={{ id: userId, email: 'err@example.com', name: 'Ошибка', role: 'user' }} />);
    const input = screen.getByPlaceholderText(ru.placeholder);
    fireEvent.change(input, { target: { value: 'вопрос' } });
    fireEvent.submit(input.closest('form')!);

    expect(await screen.findByText('Тред с ошибкой')).toBeTruthy();
  });
});

describe('TextField layout integrity', () => {
  it('keeps label text and required asterisk together in one wrapper element', () => {
    render(<TextField label="Email" required />);
    const labelText = screen.getByText('Email');
    const star = screen.getByText('*');
    expect(labelText).toBeTruthy();
    expect(star).toBeTruthy();
    // Must share the same parent wrapper so grid on label does not split them across rows
    expect(star.parentElement).toBe(labelText.parentElement);
    expect(labelText.closest('label')?.className).toContain('flex');
  });
});
