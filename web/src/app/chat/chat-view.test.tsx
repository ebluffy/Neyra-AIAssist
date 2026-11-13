import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatView } from './chat-view';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}));

describe('ChatView component', () => {
  it('renders chat view with navigation, new chat button, empty state, and composer', () => {
    const html = renderToStaticMarkup(
      <ChatView user={{ id: 'usr-1', email: 'alice@example.com', name: 'Алиса', role: 'admin' }} />
    );

    expect(html).toContain('← На главную');
    expect(html).toContain('Чат с Нейрой');
    expect(html).toContain('Новый чат');
    expect(html).toContain('Алиса');
    expect(html).toContain('admin');
    expect(html).toContain('Чем помочь?');
    expect(html).toContain('Спросите Нейру…');
    expect(html).toContain('aria-label="Отправить"');
  });
});
