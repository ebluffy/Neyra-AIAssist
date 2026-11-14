// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ProvidersSection } from './providers-section';

// Mock UI sounds
vi.mock('../../lib/ui-sounds', () => ({
  playButtonClickSound: vi.fn(),
  playModalOpenSound: vi.fn(),
  playModalCloseSound: vi.fn(),
  isUiSoundsEnabled: vi.fn(() => true),
}));

describe('ProvidersSection', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders empty state correctly when no providers exist', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes('/api/admin/providers')) {
          return {
            ok: true,
            json: async () => ({
              ok: true,
              data: { providers: [] },
            }),
          };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      }),
    );

    render(<ProvidersSection />);

    await waitFor(() => {
      expect(
        screen.getByText(/Пока нет провайдеров\. Добавьте OpenAI-совместимый шлюз или локальную модель\./i),
      ).toBeDefined();
    });
  });

  it('renders provider with saved key (has_key = true, hidden key state)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes('/api/admin/providers')) {
          return {
            ok: true,
            json: async () => ({
              ok: true,
              data: {
                providers: [
                  {
                    name: 'openai',
                    label: 'OpenAI',
                    base_url: 'https://api.openai.com/v1',
                    kind: 'openai',
                    has_key: true,
                    source: 'vault',
                    lanes: ['talk', 'brain'],
                  },
                ],
              },
            }),
          };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      }),
    );

    render(<ProvidersSection />);

    await waitFor(() => {
      expect(screen.getByText('OpenAI')).toBeDefined();
    });

    // Should indicate key is saved and hidden
    expect(screen.getByText(/Ключ сохранён · скрыт/i)).toBeDefined();
    expect(screen.getByText('Изменить ключ')).toBeDefined();

    // Lanes chips should be visible
    expect(screen.getByText('talk')).toBeDefined();
    expect(screen.getByText('brain')).toBeDefined();
  });

  it('handles verification error gracefully and displays error message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes('/verify')) {
          return {
            ok: true,
            json: async () => ({
              ok: false,
              error: 'unauthorized',
              message: 'Неверный API-ключ или доступ запрещён (401/403).',
              status_code: 401,
            }),
          };
        }
        if (u.includes('/api/admin/providers')) {
          return {
            ok: true,
            json: async () => ({
              ok: true,
              data: {
                providers: [
                  {
                    name: 'together',
                    label: 'Together AI',
                    base_url: 'https://api.together.xyz/v1',
                    kind: 'openai',
                    has_key: false,
                    source: 'none',
                    lanes: [],
                  },
                ],
              },
            }),
          };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      }),
    );

    render(<ProvidersSection />);

    await waitFor(() => {
      expect(screen.getByText('Together AI')).toBeDefined();
    });

    // Enter a key in the card
    const keyInput = screen.getByPlaceholderText('sk-…');
    fireEvent.change(keyInput, { target: { value: 'sk-invalid-test-key' } });

    // Click verify
    const verifyBtn = screen.getByRole('button', { name: 'Проверить' });
    fireEvent.click(verifyBtn);

    await waitFor(() => {
      expect(
        screen.getByText(/Неверный API-ключ или доступ запрещён/i),
      ).toBeDefined();
    });
  });

  it('handles successful verification and saving key', async () => {
    let secretSaved = false;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, opts?: RequestInit) => {
        const u = String(url);
        if (u.includes('/verify')) {
          return {
            ok: true,
            json: async () => ({
              ok: true,
              models_count: 5,
              latency_ms: 120,
              models: [{ id: 'llama-3.3-70b', name: 'Llama 3.3 70B' }],
            }),
          };
        }
        if (u.includes('/secret') && opts?.method === 'PUT') {
          secretSaved = true;
          return {
            ok: true,
            json: async () => ({
              ok: true,
              data: { has_key: true, source: 'vault' },
            }),
          };
        }
        if (u.includes('/api/admin/providers')) {
          return {
            ok: true,
            json: async () => ({
              ok: true,
              data: {
                providers: [
                  {
                    name: 'groq',
                    label: 'Groq',
                    base_url: 'https://api.groq.com/openai/v1',
                    kind: 'openai',
                    has_key: secretSaved,
                    source: secretSaved ? 'vault' : 'none',
                    lanes: [],
                  },
                ],
              },
            }),
          };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      }),
    );

    render(<ProvidersSection />);

    await waitFor(() => {
      expect(screen.getByText('Groq')).toBeDefined();
    });

    // Enter key
    const keyInput = screen.getByPlaceholderText('sk-…');
    fireEvent.change(keyInput, { target: { value: 'gsk_valid_test_key_123' } });

    // Click verify
    const verifyBtn = screen.getByRole('button', { name: 'Проверить' });
    fireEvent.click(verifyBtn);

    // Verified indicator appears
    await waitFor(() => {
      expect(screen.getByText(/5 моделей доступно/i)).toBeDefined();
    });

    // Click save
    const saveBtn = screen.getByRole('button', { name: 'Сохранить' });
    fireEvent.click(saveBtn);

    // Upon save, the input should disappear, and "Ключ сохранён · скрыт" appears
    await waitFor(() => {
      expect(screen.getByText(/Ключ сохранён · скрыт/i)).toBeDefined();
    });
    expect(screen.queryByPlaceholderText('sk-…')).toBeNull();
  });

  it('navigates to dedicated provider screen and deletes provider with slug confirmation', async () => {
    let providerDeleted = false;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, opts?: RequestInit) => {
        const u = String(url);
        if (u.includes('/providers/custom-gw') && opts?.method === 'DELETE') {
          providerDeleted = true;
          return {
            ok: true,
            json: async () => ({ ok: true, data: { deleted: true } }),
          };
        }
        if (u.includes('/api/admin/providers')) {
          return {
            ok: true,
            json: async () => ({
              ok: true,
              data: {
                providers: providerDeleted
                  ? []
                  : [
                      {
                        name: 'custom-gw',
                        label: 'Custom Gateway',
                        base_url: 'https://gateway.example.com/v1',
                        kind: 'openai',
                        has_key: false,
                        source: 'none',
                        lanes: [],
                      },
                    ],
              },
            }),
          };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      }),
    );

    render(<ProvidersSection />);

    await waitFor(() => {
      expect(screen.getByText('Custom Gateway')).toBeDefined();
    });

    // Click on the provider card to enter dedicated provider screen
    const cardTitle = screen.getByText('Custom Gateway');
    fireEvent.click(cardTitle);

    // Dedicated screen should show breadcrumbs
    await waitFor(() => {
      expect(screen.getByText('Назад к списку')).toBeDefined();
    });

    // Check danger zone delete section
    expect(screen.getByText('Опасная зона')).toBeDefined();
    const deleteBtn = screen.getByRole('button', { name: 'Удалить провайдера…' });
    fireEvent.click(deleteBtn);

    // Confirmation input appears
    const confirmInput = screen.getByPlaceholderText('custom-gw');
    fireEvent.change(confirmInput, { target: { value: 'custom-gw' } });

    const confirmDeleteBtn = screen.getByRole('button', { name: 'Удалить навсегда' });
    fireEvent.click(confirmDeleteBtn);

    // Back on list screen with empty state
    await waitFor(() => {
      expect(
        screen.getByText(/Пока нет провайдеров\. Добавьте OpenAI-совместимый шлюз или локальную модель\./i),
      ).toBeDefined();
    });
  });

  it('handles lane occupation and conflict when provider is occupied by lanes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes('/api/admin/providers')) {
          return {
            ok: true,
            json: async () => ({
              ok: true,
              data: {
                providers: [
                  {
                    name: 'openai',
                    label: 'OpenAI',
                    base_url: 'https://api.openai.com/v1',
                    kind: 'openai',
                    has_key: true,
                    source: 'vault',
                    lanes: ['talk', 'brain'],
                  },
                ],
              },
            }),
          };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      }),
    );

    render(<ProvidersSection />);

    await waitFor(() => {
      expect(screen.getByText('OpenAI')).toBeDefined();
    });

    // Click on card to open dedicated provider screen
    fireEvent.click(screen.getByText('OpenAI'));

    await waitFor(() => {
      expect(screen.getByText('Назад к списку')).toBeDefined();
    });

    // Should display warning that provider is in use by lanes
    expect(
      screen.getByText(/Провайдер используется в лейнах \(talk, brain\)/i),
    ).toBeDefined();
  });
});
