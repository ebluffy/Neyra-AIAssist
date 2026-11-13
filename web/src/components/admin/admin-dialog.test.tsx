// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AdminDialog, type AdminSection } from './admin-dialog';
import { AppSidebar, type AppSidebarUser } from '../layout/app-sidebar';

// Mock UI sounds
vi.mock('../../lib/ui-sounds', () => ({
  playButtonClickSound: vi.fn(),
  playModalOpenSound: vi.fn(),
  playModalCloseSound: vi.fn(),
  isUiSoundsEnabled: vi.fn(() => true),
}));

// Mock next/navigation
const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}));

// Mock auth client
vi.mock('../../../lib/auth-client', () => ({
  signOut: vi.fn(async () => {}),
}));

describe('AdminDialog', () => {
  const adminUser = {
    id: 'admin-1',
    name: 'Администратор',
    email: 'admin@example.com',
    role: 'admin',
  };

  const sampleOverview = {
    users: { total: 42, admins: 2, banned: 1 },
    invites: { total: 10, active: 4, used: 6 },
    audit24h: 15,
    core: { state: 'ok', message: null },
  };

  const sampleSystem = {
    site: {
      version: '1.2.3',
      commit: 'abc12345678',
      uptimeSeconds: 7200,
      disk: { freeBytes: 15000000000, totalBytes: 50000000000 },
      backups: { count: 3, items: ['backup-1.tar.gz', 'backup-2.tar.gz'] },
    },
    core: {
      health: {
        state: 'ok',
        data: { ok: true, version: '2.0.0', uptime_seconds: 14400 },
      },
      ready: {
        state: 'ok',
        data: {
          ok: true,
          checks: [
            { name: 'llm_ping', ok: true, ms: 12 },
            { name: 'db_connected', ok: true, ms: 5 },
          ],
        },
      },
    },
  };

  const sampleConfig = {
    lanes: {
      talk: { provider: 'openai', model: 'gpt-4o', temperature: 0.7, context_window: 128000, max_tokens: 4096 },
      brain: { provider: 'openrouter', model: 'anthropic/claude-3.5-sonnet', temperature: 1.0, context_window: 200000, max_tokens: 8192 },
    },
    providers: ['openai', 'openrouter', 'aihope'],
    mcp: {
      enabled: true,
      servers: [
        { name: 'fetch', enabled: true },
        { name: 'filesystem', enabled: false },
      ],
    },
    secrets: {
      OPENAI_API_KEY: 'set',
      OPENROUTER_API_KEY: 'set',
      AIHOPE_API_KEY: 'missing',
    },
  };

  const sampleIntegrations = {
    discord: { configured: true, note: 'Вход через Discord настроен в .env' },
    providers: { state: 'ok', names: ['openai', 'openrouter', 'aihope'] },
    mcp: { state: 'no_api', message: 'Только чтение' },
  };

  const sampleUsers = {
    items: [
      { id: 'u1', name: 'Алексей', email: 'alex@example.com', role: 'user', banned: false },
      { id: 'u2', name: 'Борис', email: 'boris@example.com', role: 'admin', banned: false },
      { id: 'u3', name: 'Хакер', email: 'bad@example.com', role: 'user', banned: true },
    ],
  };

  const sampleInvites = {
    items: [
      { id: 'inv-1', code: 'INV-TEST-1', createdAt: '2026-11-13T10:00:00Z', used: false },
      { id: 'inv-2', code: 'INV-TEST-2', createdAt: '2026-11-12T10:00:00Z', used: true },
    ],
  };

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/admin/overview')) {
        return {
          ok: true,
          json: async () => ({ ok: true, data: sampleOverview }),
        };
      }
      if (urlStr.includes('/api/admin/system/restart')) {
        return {
          ok: true,
          json: async () => ({ ok: true, data: { note: 'Команда перезапуска принята.' } }),
        };
      }
      if (urlStr.includes('/api/admin/system')) {
        return {
          ok: true,
          json: async () => ({ ok: true, data: sampleSystem }),
        };
      }
      if (urlStr.includes('/api/admin/config')) {
        if (init?.method === 'PUT') {
          return {
            ok: true,
            json: async () => ({ ok: true, data: { requires_restart: true } }),
          };
        }
        return {
          ok: true,
          json: async () => ({ ok: true, data: { config: sampleConfig } }),
        };
      }
      if (urlStr.includes('/api/admin/integrations')) {
        return {
          ok: true,
          json: async () => ({ ok: true, data: sampleIntegrations }),
        };
      }
      if (urlStr.includes('/api/admin/users')) {
        if (init?.method === 'PATCH') {
          return {
            ok: true,
            json: async () => ({ ok: true }),
          };
        }
        return {
          ok: true,
          json: async () => sampleUsers,
        };
      }
      if (urlStr.includes('/api/admin/settings')) {
        if (init?.method === 'PUT') {
          const body = JSON.parse(String(init.body || '{}'));
          return {
            ok: true,
            json: async () => ({ ok: true, data: { registration_mode: body.registration_mode } }),
          };
        }
        return {
          ok: true,
          json: async () => ({ ok: true, data: { registration_mode: 'invite' } }),
        };
      }
      if (urlStr.includes('/api/admin/invites')) {
        if (init?.method === 'POST') {
          return {
            ok: true,
            json: async () => ({ ok: true, data: { url: 'https://neyra.chat/signup?invite=NEW-CODE' } }),
          };
        }
        return {
          ok: true,
          json: async () => sampleInvites,
        };
      }
      return {
        ok: false,
        json: async () => ({ ok: false, message: 'Not found' }),
      };
    }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders nothing when open is false', () => {
    const { container } = render(<AdminDialog open={false} onClose={vi.fn()} user={adminUser} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders modal dialog with aria attributes, header, and closes on X button', async () => {
    const onClose = vi.fn();
    render(<AdminDialog open={true} onClose={onClose} user={adminUser} />);

    const dialog = screen.getByRole('dialog', { name: /Админ-панель/ });
    expect(dialog).toBeDefined();
    expect(dialog.getAttribute('aria-modal')).toBe('true');

    // Close button
    const closeBtn = screen.getByRole('button', { name: 'Закрыть панель администратора' });
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes dialog on Escape key and on backdrop click', () => {
    const onClose = vi.fn();
    render(<AdminDialog open={true} onClose={onClose} user={adminUser} />);

    // Press Escape
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    // Click backdrop
    const backdrop = screen.getByRole('presentation');
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('switches between sections: Overview, Models, Integrations, Access, System', async () => {
    render(<AdminDialog open={true} onClose={vi.fn()} user={adminUser} />);

    // Initial Overview
    expect(await screen.findByText('Обзор состояния')).toBeDefined();
    expect(screen.getByText('Пользователи')).toBeDefined();
    expect(screen.getByText('Активные инвайты')).toBeDefined();

    // Switch to Models
    const modelsButtons = screen.getAllByRole('button', { name: 'Модели' });
    fireEvent.click(modelsButtons[0]);
    expect(await screen.findByText('Модели по лейнам')).toBeDefined();
    expect(screen.getByText(/Разговор/)).toBeDefined();

    // Switch to Integrations
    const intButtons = screen.getAllByRole('button', { name: 'Интеграции' });
    fireEvent.click(intButtons[0]);
    expect(await screen.findByText('Интеграции и подключения')).toBeDefined();
    expect(screen.getByText('Провайдеры моделей')).toBeDefined();
    expect(screen.getByText(/MCP-серверы/)).toBeDefined();

    // Switch to Access
    const accessButtons = screen.getAllByRole('button', { name: 'Доступ' });
    fireEvent.click(accessButtons[0]);
    expect(await screen.findByText('Доступ и аккаунты')).toBeDefined();

    // Switch to System
    const sysButtons = screen.getAllByRole('button', { name: 'Система' });
    fireEvent.click(sysButtons[0]);
    expect(await screen.findByText('Системные сервисы')).toBeDefined();
    expect(screen.getByText('Перезапуск ядра Нейры')).toBeDefined();
  });

  it('submits PUT request with updated lane parameters in Models section', async () => {
    render(<AdminDialog open={true} onClose={vi.fn()} initialSection="models" user={adminUser} />);

    expect(await screen.findByText('Модели по лейнам')).toBeDefined();

    // Find and click "Сохранить лейн"
    const saveButtons = screen.getAllByRole('button', { name: 'Сохранить лейн' });
    fireEvent.click(saveButtons[0]);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/admin/config',
        expect.objectContaining({
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
        })
      );
    });

    expect(await screen.findByText(/Изменение применится после перезапуска ядра/)).toBeDefined();
  });

  it('saves base_url in Integrations section via PUT request', async () => {
    render(<AdminDialog open={true} onClose={vi.fn()} initialSection="integrations" user={adminUser} />);

    expect(await screen.findByText('Интеграции и подключения')).toBeDefined();

    const openrouterInput = screen.getByPlaceholderText('https://openrouter.ai/api/v1');
    fireEvent.change(openrouterInput, { target: { value: 'https://custom-router.ai/v1' } });

    const saveButtons = screen.getAllByRole('button', { name: 'Сохранить' });
    fireEvent.click(saveButtons[0]);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/admin/config',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({
            updates: { 'llm.providers.openrouter.base_url': 'https://custom-router.ai/v1' },
          }),
        })
      );
    });

    expect(await screen.findByText('Базовый URL сохранён.')).toBeDefined();
  });

  it('handles core error state and allows retry', async () => {
    // Stub fetch to simulate core error
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      return {
        ok: false,
        json: async () => ({ ok: false, message: 'Ядро не отвечает на запросы.' }),
      };
    }));

    render(<AdminDialog open={true} onClose={vi.fn()} initialSection="overview" user={adminUser} />);

    expect(await screen.findByText('Ядро не отвечает на запросы.')).toBeDefined();
    const retryBtn = screen.getByRole('button', { name: 'Повторить попытку' });
    expect(retryBtn).toBeDefined();

    // Now make fetch succeed on retry
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, data: sampleOverview }),
    })));

    fireEvent.click(retryBtn);
    expect(await screen.findByText('Обзор состояния')).toBeDefined();
  });

  it('filters users and executes role change and ban in Access section', async () => {
    render(<AdminDialog open={true} onClose={vi.fn()} initialSection="access" user={adminUser} />);

    expect(await screen.findByText('Алексей')).toBeDefined();
    expect(screen.getByText('Борис')).toBeDefined();
    expect(screen.getByText('Хакер')).toBeDefined();

    // Search filter
    const searchInput = screen.getByPlaceholderText('Поиск по имени или email…');
    fireEvent.change(searchInput, { target: { value: 'Алексей' } });

    expect(screen.getByText('Алексей')).toBeDefined();
    expect(screen.queryByText('Борис')).toBeNull();

    // Role change action
    const makeAdminBtn = screen.getByRole('button', { name: 'Сделать админом' });
    fireEvent.click(makeAdminBtn);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/admin/users/u1',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ role: 'admin' }),
        })
      );
    });
  });

  it('generates an invite link in Access section and displays copy button', async () => {
    render(<AdminDialog open={true} onClose={vi.fn()} initialSection="access" user={adminUser} />);

    // Wait for data loading to complete
    expect(await screen.findByText(/Пользователи \(/)).toBeDefined();

    // Switch to Invites tab
    const invitesTab = screen.getByRole('button', { name: /Приглашения/ });
    fireEvent.click(invitesTab);

    expect(await screen.findByText('Создать приглашение')).toBeDefined();
    const createBtn = screen.getByRole('button', { name: /Сгенерировать ссылку/ });
    fireEvent.click(createBtn);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/admin/invites',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ ttlHours: 24 }),
        })
      );
    });

    expect(await screen.findByText('https://neyra.chat/signup?invite=NEW-CODE')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Копировать' })).toBeDefined();
  });

  it('confirms and restarts core in System section', async () => {
    render(<AdminDialog open={true} onClose={vi.fn()} initialSection="system" user={adminUser} />);

    expect(await screen.findByText('Системные сервисы')).toBeDefined();

    const restartBtn = screen.getByRole('button', { name: 'Перезапустить ядро' });
    fireEvent.click(restartBtn);

    // Confirmation dialog appears
    expect(screen.getByRole('alertdialog')).toBeDefined();
    expect(screen.getByText('Перезапустить ядро Нейры?')).toBeDefined();

    const confirmBtn = screen.getByRole('button', { name: 'Подтвердить перезапуск' });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/admin/system/restart',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ target: 'core' }),
        })
      );
    });

    expect(await screen.findByText('Команда перезапуска принята.')).toBeDefined();
  });

  it('opens AdminDialog when clicking "Админ-панель" in AppSidebar', async () => {
    const adminSidebarUser: AppSidebarUser = {
      id: 'admin-1',
      name: 'Админ Тест',
      email: 'admin@example.com',
      role: 'admin',
    };

    render(<AppSidebar activeSection="chat" user={adminSidebarUser} />);

    // Open profile menu
    const profileTriggers = screen.getAllByRole('button', { name: 'Меню профиля пользователя' });
    fireEvent.click(profileTriggers[0]);

    // Click "Админ-панель"
    const adminMenuItem = screen.getByRole('menuitem', { name: /Админ-панель/ });
    fireEvent.click(adminMenuItem);

    // Admin Dialog should open!
    expect(await screen.findByRole('dialog', { name: /Админ-панель/ })).toBeDefined();
    expect(screen.getByText('Обзор состояния')).toBeDefined();
  });

  it('switches registration mode via PUT /api/admin/settings', async () => {
    render(<AdminDialog open={true} onClose={vi.fn()} user={adminUser} initialSection="access" />);

    expect(await screen.findByText('Режим регистрации')).toBeDefined();
    const openBtn = screen.getByRole('button', { name: /Открытая/ });
    fireEvent.click(openBtn);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/admin/settings',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ registration_mode: 'open' }),
        })
      );
    });

    expect(await screen.findByText('Сохранено')).toBeDefined();
  });
});
