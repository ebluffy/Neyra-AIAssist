// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppSidebar, AppSidebarUser } from './app-sidebar';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}));

vi.mock('../../../lib/auth-client', () => ({
  signOut: vi.fn(async () => {}),
}));

let mockThreads: Array<{ id: string; title: string; updatedAt: string }> = [];
let mockNotes: Array<{ id: string; title: string; content: string; updatedAt: string; pinned?: boolean }> = [];

vi.mock('../../../lib/history-client', () => ({
  apiListThreads: vi.fn(async () => ({ items: [...mockThreads], next_cursor: null })),
  apiDeleteThread: vi.fn(async (id: string) => {
    mockThreads = mockThreads.filter((t) => t.id !== id);
    return true;
  }),
  apiListNotes: vi.fn(async () => ({
    items: mockNotes.map((n) => ({
      id: n.id,
      user_id: 'user-1',
      thread_id: null,
      text: n.title ? `${n.title}\n\n${n.content}` : n.content,
      pinned: Boolean(n.pinned),
      created_at: n.updatedAt,
      updated_at: n.updatedAt,
    })),
    next_cursor: null,
  })),
  apiCreateNote: vi.fn(async (data: { text: string; pinned?: boolean }) => {
    const lines = (data.text || '').split('\n\n');
    const title = lines.length > 1 ? lines[0] : '';
    const content = lines.length > 1 ? lines.slice(1).join('\n\n') : data.text;
    const note = {
      id: `note-${Date.now()}`,
      title,
      content,
      updatedAt: new Date().toISOString(),
      pinned: Boolean(data.pinned),
    };
    mockNotes.push(note);
    return {
      id: note.id,
      user_id: 'user-1',
      thread_id: null,
      text: data.text,
      pinned: Boolean(data.pinned),
      created_at: note.updatedAt,
      updated_at: note.updatedAt,
    };
  }),
  apiUpdateNote: vi.fn(async (id: string, data: { text?: string; pinned?: boolean }) => {
    const idx = mockNotes.findIndex((n) => n.id === id);
    if (idx !== -1) {
      if (data.text !== undefined) {
        const lines = data.text.split('\n\n');
        mockNotes[idx].title = lines.length > 1 ? lines[0] : '';
        mockNotes[idx].content = lines.length > 1 ? lines.slice(1).join('\n\n') : data.text;
      }
      if (data.pinned !== undefined) {
        mockNotes[idx].pinned = data.pinned;
      }
      const n = mockNotes[idx];
      return {
        id: n.id,
        user_id: 'user-1',
        thread_id: null,
        text: data.text !== undefined ? data.text : (n.title ? `${n.title}\n\n${n.content}` : n.content),
        pinned: Boolean(n.pinned),
        created_at: n.updatedAt,
        updated_at: n.updatedAt,
      };
    }
    throw new Error('Not found');
  }),
  apiDeleteNote: vi.fn(async (id: string) => {
    mockNotes = mockNotes.filter((n) => n.id !== id);
    return true;
  }),
  importLocalStorageData: vi.fn(async (userId: string) => {
    try {
      const rawThreads = window.localStorage.getItem(`neyra:threads:${userId}`);
      if (rawThreads) mockThreads = JSON.parse(rawThreads);
      const rawNotes = window.localStorage.getItem(`neyra:notes:${userId}`);
      if (rawNotes) mockNotes = JSON.parse(rawNotes);
      window.localStorage.setItem(`neyra:imported-to-db:${userId}`, '1');
    } catch {}
    return { threadsCount: mockThreads.length, notesCount: mockNotes.length };
  }),
}));

describe('AppSidebar', () => {
  const adminUser: AppSidebarUser = {
    id: 'user-admin-1',
    name: 'Админ Тест',
    email: 'admin@example.com',
    role: 'admin',
  };

  const normalUser: AppSidebarUser = {
    id: 'user-normal-2',
    name: 'Юзер Тест',
    email: 'user@example.com',
    role: 'user',
  };

  beforeEach(() => {
    window.localStorage.clear();
    mockThreads = [];
    mockNotes = [];
    push.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders expanded sidebar by default with logo, new chat, and tabs', () => {
    render(<AppSidebar activeSection="chat" user={adminUser} />);

    expect(screen.getByText('Neyra')).toBeDefined();
    expect(screen.getByRole('button', { name: /Новый чат/ })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Чаты' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Заметки' })).toBeDefined();
    expect(screen.getByText('Каналы (Discord)')).toBeDefined();
  });

  it('filters chat threads by search query', async () => {
    const threads = [
      { id: '1', title: 'Вопрос по Python', updatedAt: '2026-01-01' },
      { id: '2', title: 'Обсуждение Docker', updatedAt: '2026-01-02' },
      { id: '3', title: 'Фронтенд архитектура', updatedAt: '2026-01-03' },
    ];
    window.localStorage.setItem(`neyra:threads:${adminUser.id}`, JSON.stringify(threads));

    render(<AppSidebar activeSection="chat" user={adminUser} />);

    expect(await screen.findByText('Вопрос по Python')).toBeDefined();
    expect(screen.getByText('Обсуждение Docker')).toBeDefined();
    expect(screen.getByText('Фронтенд архитектура')).toBeDefined();

    const searchInput = screen.getByRole('searchbox', { name: 'Поиск по чатам' });
    fireEvent.change(searchInput, { target: { value: 'Docker' } });

    expect(screen.getByText('Обсуждение Docker')).toBeDefined();
    expect(screen.queryByText('Вопрос по Python')).toBeNull();
    expect(screen.queryByText('Фронтенд архитектура')).toBeNull();

    // Clear search
    const clearButton = screen.getByRole('button', { name: 'Очистить поиск' });
    fireEvent.click(clearButton);

    expect(screen.getByText('Вопрос по Python')).toBeDefined();
    expect(screen.getByText('Обсуждение Docker')).toBeDefined();

    // Search query with no matches
    fireEvent.change(searchInput, { target: { value: 'Несуществующий' } });
    expect(screen.getByText('Ничего не найдено')).toBeDefined();
  });

  it('manages user notes in database scoped to user.id', async () => {
    render(<AppSidebar activeSection="chat" user={normalUser} />);

    // Switch to notes tab
    fireEvent.click(screen.getByRole('button', { name: 'Заметки' }));

    expect(screen.getByText('Личные заметки в базе данных')).toBeDefined();
    expect(await screen.findByText('Заметок пока нет')).toBeDefined();

    // Add note
    fireEvent.click(screen.getByRole('button', { name: 'Добавить заметку' }));

    const titleInput = await screen.findByRole('textbox', { name: 'Заголовок заметки' });
    const contentInput = screen.getByRole('textbox', { name: 'Текст заметки' });

    fireEvent.change(titleInput, { target: { value: 'Моя тестовая заметка' } });
    fireEvent.change(contentInput, { target: { value: 'Секретный контент' } });

    fireEvent.click(screen.getByRole('button', { name: /Сохранить/ }));

    // Verify displayed
    expect(await screen.findByText('Моя тестовая заметка')).toBeDefined();
    expect(screen.getByText('Секретный контент')).toBeDefined();

    // Verify stored in mockNotes
    expect(mockNotes.length).toBe(1);
    expect(mockNotes[0].title).toBe('Моя тестовая заметка');

    // Delete note
    const deleteBtn = screen.getByRole('button', { name: 'Удалить заметку' });
    fireEvent.click(deleteBtn);

    await waitFor(() => expect(screen.queryByText('Моя тестовая заметка')).toBeNull());
    expect(mockNotes.length).toBe(0);
  });

  it('renders collapsed rail with required actions when collapsed', () => {
    window.localStorage.setItem('neyra:sidebar-collapsed', '1');
    render(<AppSidebar activeSection="chat" user={adminUser} />);

    // Collapsed rail icons
    expect(screen.getByRole('button', { name: 'Развернуть панель' })).toBeDefined();
    expect(screen.getAllByRole('button', { name: 'Новый чат' }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole('button', { name: 'Чаты' }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole('button', { name: 'Заметки' }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('button', { name: 'Каналы' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Настройки' })).toBeDefined();
    expect(screen.getAllByRole('button', { name: 'Меню профиля пользователя' }).length).toBeGreaterThanOrEqual(1);
  });

  it('handles mobile drawer backdrop click and Escape key', () => {
    const onCloseMobile = vi.fn();
    render(
      <AppSidebar
        activeSection="chat"
        user={normalUser}
        mobileOpen={true}
        onCloseMobile={onCloseMobile}
      />
    );

    // Backdrop present and clickable
    const backdrop = document.querySelector('[role="presentation"]');
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop!);
    expect(onCloseMobile).toHaveBeenCalledTimes(1);

    // Escape key closes mobile drawer
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCloseMobile).toHaveBeenCalledTimes(2);
  });

  it('selects and deletes threads from the sidebar thread list', async () => {
    const onSelectThread = vi.fn();
    const onDeleteThread = vi.fn();
    const threads = [
      { id: 'th-1', title: 'Обсуждение Docker', updatedAt: '2026-01-02' },
      { id: 'th-2', title: 'Вопрос по Python', updatedAt: '2026-01-01' },
    ];
    window.localStorage.setItem(`neyra:threads:${adminUser.id}`, JSON.stringify(threads));

    render(
      <AppSidebar
        activeSection="chat"
        user={adminUser}
        activeThreadId="th-1"
        onSelectThread={onSelectThread}
        onDeleteThread={onDeleteThread}
      />
    );

    expect(await screen.findByText('Обсуждение Docker')).toBeDefined();

    // Select thread th-2
    fireEvent.click(screen.getByText('Вопрос по Python'));
    expect(onSelectThread).toHaveBeenCalledWith('th-2');

    // Delete thread th-1
    const deleteBtn = screen.getByRole('button', { name: 'Удалить Обсуждение Docker' });
    fireEvent.click(deleteBtn);
    await waitFor(() => expect(onDeleteThread).toHaveBeenCalledWith('th-1'));
  });

  it('opens and closes user profile menu popover', () => {
    const onOpenSettings = vi.fn();
    render(<AppSidebar activeSection="chat" user={adminUser} onOpenSettings={onOpenSettings} />);

    const profileTriggers = screen.getAllByRole('button', { name: 'Меню профиля пользователя' });
    fireEvent.click(profileTriggers[0]);

    expect(screen.getByRole('menu', { name: 'Меню профиля' })).toBeDefined();
    expect(screen.getByText('Админ-панель')).toBeDefined();

    const settingsItem = screen.getByRole('menuitem', { name: /Настройки/ });
    fireEvent.click(settingsItem);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('applies fixed positioning on mobile and static on desktop to avoid document flow shift', () => {
    render(<AppSidebar activeSection="chat" user={normalUser} mobileOpen={false} />);
    const aside = screen.getByLabelText('Боковая панель навигации');
    expect(aside.classList.contains('fixed')).toBe(true);
    expect(aside.classList.contains('lg:static')).toBe(true);
    expect(aside.classList.contains('relative')).toBe(false);
  });
});
