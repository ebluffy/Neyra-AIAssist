// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ChatView } from './chat-view';
import { TextField } from '../../components/ui';
import { resolveTabKey } from '../../../lib/chat-id';
import { ru } from '../../i18n';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}));

beforeAll(() => { Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear(); window.name = ''; });

function sseResponse(tokenText = 'привет'): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: {"type":"token","text":"${tokenText}"}\n\n`));
      controller.enqueue(new TextEncoder().encode(`data: {"type":"done","text":"${tokenText}"}\n\n`));
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
    vi.stubGlobal('fetch', fetchMock);
    render(<ChatView user={{ id: 'u1', email: 'a@example.com', name: 'Аня', role: 'user' }} />);

    const input = screen.getByPlaceholderText(ru.placeholder);
    for (const text of ['первое', 'второе']) {
      fireEvent.change(input, { target: { value: text } });
      fireEvent.submit(input.closest('form')!);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(text === 'первое' ? 1 : 2));
      await waitFor(() => expect(screen.queryByText('Нейра думает…')).toBeNull());
    }

    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies).toHaveLength(2);
    expect(bodies[0].chat_id).toBeTruthy();
    expect(bodies[1].chat_id).toBe(bodies[0].chat_id);
    expect(sessionStorage.getItem(`neyra.chat_id:u1:${resolveTabKey(window)}`)).toBe(bodies[0].chat_id);
  });

  it('opens a new thread in a tab that inherited sessionStorage (AR-11)', async () => {
    sessionStorage.setItem('neyra.chat_id:u1:opener-tab', 'old-thread');
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => sseResponse());
    vi.stubGlobal('fetch', fetchMock);
    render(<ChatView user={{ id: 'u1', email: 'a@example.com', name: 'Аня', role: 'user' }} />);

    const input = screen.getByPlaceholderText(ru.placeholder);
    fireEvent.change(input, { target: { value: 'новая вкладка' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.chat_id).toBeTruthy();
    expect(body.chat_id).not.toBe('old-thread');
  });

  it('removes empty assistant message bubble when stream emits error before any token (AR-7)', async () => {
    const fetchMock = vi.fn(async () => sseErrorResponse('Сервер перегружен'));
    vi.stubGlobal('fetch', fetchMock);
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
    vi.stubGlobal('fetch', fetchMock);

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
    const fetchMock = vi.fn(async () => sseErrorResponse('Неисправимая ошибка'));
    vi.stubGlobal('fetch', fetchMock);

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
  });

  it('clicking "Новый чат" resets messages and issues a fresh chat_id (AR-12)', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => sseResponse());
    vi.stubGlobal('fetch', fetchMock);
    render(<ChatView user={{ id: 'u1', email: 'a@example.com', name: 'Аня', role: 'user' }} />);

    const input = screen.getByPlaceholderText(ru.placeholder);
    fireEvent.change(input, { target: { value: 'первый чат' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(screen.getByText('привет')).toBeTruthy());

    const firstBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
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
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const secondBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(secondBody.chat_id).toBeTruthy();
    expect(secondBody.chat_id).not.toBe(firstChatId);
  });

  it('aborts the request when the page unmounts mid-answer', async () => {
    let aborted = false;
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
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
    vi.stubGlobal('fetch', fetchMock);

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

    // Switch to thread 2 from sidebar
    fireEvent.click(screen.getByText('Второй сохранённый тред'));

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
    vi.stubGlobal('fetch', fetchMock);
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
