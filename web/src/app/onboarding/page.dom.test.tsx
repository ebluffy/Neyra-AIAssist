// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import OnboardingPage from './page';
import { emitToast } from '../../lib/toast';

const replace = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
}));
vi.mock('../../lib/toast', () => ({ emitToast: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

function goToStepTwo() {
  fireEvent.click(screen.getByRole('button', { name: /Далее/ }));
}

describe('Onboarding (AR-72)', () => {
  it('saves the name through PATCH /api/me and reports success only after the server accepts', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(<OnboardingPage />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  Боб  ' } });
    goToStepTwo();
    fireEvent.click(screen.getByRole('button', { name: /Завершить настройку/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/me',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ name: 'Боб' }) }),
    );
    await waitFor(() => expect(emitToast).toHaveBeenCalled());
    const toast = vi.mocked(emitToast).mock.calls[0][0];
    expect(toast.tone).toBe('success');
    expect(toast.title).toMatch(/Имя сохранено/);
  });

  it('does not claim success when the server rejects the name', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"ok":false}', { status: 500 })),
    );

    render(<OnboardingPage />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Боб' } });
    goToStepTwo();
    fireEvent.click(screen.getByRole('button', { name: /Завершить настройку/ }));

    await waitFor(() => expect(emitToast).toHaveBeenCalled());
    const toast = vi.mocked(emitToast).mock.calls[0][0];
    expect(toast.tone).toBe('danger');
    expect(toast.title).toMatch(/не сохранено/i);
  });

  it('keeps privacy switches read-only and does not write privacy flags it cannot apply', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    render(<OnboardingPage />);
    goToStepTwo();

    const switches = screen.getAllByRole('switch');
    expect(switches).toHaveLength(2);
    for (const element of switches) {
      expect((element as HTMLButtonElement).disabled).toBe(true);
    }

    fireEvent.click(screen.getByRole('button', { name: /Завершить настройку/ }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/chat'));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(window.localStorage.getItem('neyra:remember-context')).toBeNull();
    expect(window.localStorage.getItem('neyra:sync-discord')).toBeNull();
  });
});
