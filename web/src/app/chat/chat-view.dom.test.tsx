// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ChatView } from './chat-view';

beforeAll(() => { Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear(); });

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

describe('ChatView conversation', () => {
  it('sends one chat_id for every message of the same conversation', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => sseResponse());
    vi.stubGlobal('fetch', fetchMock);
    render(<ChatView user={{ id: 'u1', email: 'a@example.com', name: 'Аня', role: 'user' }} />);

    const input = screen.getByPlaceholderText('Введите сообщение…');
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
    expect(sessionStorage.getItem('neyra.chat_id')).toBe(bodies[0].chat_id);
  });

  it('aborts the request when the page unmounts mid-answer', async () => {
    let aborted = false;
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => { aborted = true; reject(new DOMException('aborted', 'AbortError')); });
    })));
    const view = render(<ChatView user={{ id: 'u1', email: 'a@example.com', name: 'Аня', role: 'user' }} />);
    const input = screen.getByPlaceholderText('Введите сообщение…');
    fireEvent.change(input, { target: { value: 'долгий ответ' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(screen.getByText('Нейра думает…')).toBeTruthy());
    view.unmount();
    await waitFor(() => expect(aborted).toBe(true));
  });
});
