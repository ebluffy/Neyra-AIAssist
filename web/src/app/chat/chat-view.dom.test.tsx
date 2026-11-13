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

function sseResponse(): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"token","text":"привет"}\n\n'));
      controller.enqueue(new TextEncoder().encode('data: {"type":"done","text":"привет"}\n\n'));
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
    // Assistant message bubble should be removed, leaving only the user message
    expect(screen.queryByText('…')).toBeNull();
    expect(screen.queryByText('Нейра')).toBeNull();
    expect(screen.getByText('Вы')).toBeTruthy();
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
