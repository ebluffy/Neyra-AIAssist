// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    expect(screen.getByRole('menu', { name: 'Меню профиля' })).toBeTruthy();
    expect(screen.getByText('Настройки')).toBeTruthy();
    expect(screen.getByText('Админ-панель')).toBeTruthy();
    expect(screen.getByText(ru.signOut)).toBeTruthy();
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
          prompt_tokens: 100000,
          completion_tokens: 20000,
          context_limit: 1000000,
          context_used: 120000,
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
          prompt_tokens: 100000,
          completion_tokens: 20000,
          context_limit: 1000000,
          context_used: 120000,
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
