import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatView } from './chat-view';

describe('ChatView component', () => {
  it('renders chat view with navigation back to home and input form', () => {
    const html = renderToStaticMarkup(
      <ChatView user={{ id: 'usr-1', email: 'alice@example.com', name: 'Алиса', role: 'admin' }} />
    );

    expect(html).toContain('← На главную');
    expect(html).toContain('Чат с Нейрой');
    expect(html).toContain('Алиса');
    expect(html).toContain('admin');
    expect(html).toContain('Начните диалог с Нейрой');
    expect(html).toContain('Введите сообщение…');
    expect(html).toContain('Отправить');
  });
});
