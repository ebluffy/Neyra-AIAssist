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
    expect(screen.getByText('Чаты не найдены')).toBeDefined();
  });

  it('manages user notes in localStorage scoped to user.id', async () => {
    render(<AppSidebar activeSection="chat" user={normalUser} />);

    // Switch to notes tab
    fireEvent.click(screen.getByRole('button', { name: 'Заметки' }));

    expect(screen.getByText('Хранятся в этом браузере')).toBeDefined();
    expect(screen.getByText('Заметок пока нет')).toBeDefined();

    // Add note
    fireEvent.click(screen.getByRole('button', { name: 'Добавить заметку' }));

    const titleInput = screen.getByRole('textbox', { name: 'Заголовок заметки' });
    const contentInput = screen.getByRole('textbox', { name: 'Текст заметки' });

    fireEvent.change(titleInput, { target: { value: 'Моя тестовая заметка' } });
    fireEvent.change(contentInput, { target: { value: 'Секретный контент' } });

    fireEvent.click(screen.getByRole('button', { name: /Сохранить/ }));

    // Verify displayed
    expect(await screen.findByText('Моя тестовая заметка')).toBeDefined();
    expect(screen.getByText('Секретный контент')).toBeDefined();

    // Verify localStorage key
    const rawStored = window.localStorage.getItem(`neyra:notes:${normalUser.id}`);
    expect(rawStored).toBeTruthy();
    const parsed = JSON.parse(rawStored || '[]');
    expect(parsed.length).toBe(1);
    expect(parsed[0].title).toBe('Моя тестовая заметка');

    // Delete note
    const deleteBtn = screen.getByRole('button', { name: 'Удалить заметку' });
    fireEvent.click(deleteBtn);

    expect(screen.queryByText('Моя тестовая заметка')).toBeNull();
    const afterDelete = JSON.parse(window.localStorage.getItem(`neyra:notes:${normalUser.id}`) || '[]');
    expect(afterDelete.length).toBe(0);
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
    const { rerender } = render(
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
});
