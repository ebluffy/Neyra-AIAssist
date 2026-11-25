// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { getAuth } from '../../../../lib/auth';
import { resolveShareToken } from '../../../../lib/share-store';
import { notFound, redirect } from 'next/navigation';
import SharedConversationPage from './page';

vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
  notFound: vi.fn(() => {
    throw new Error('notFound');
  }),
}));
vi.mock('../../../../lib/auth', () => ({ getAuth: vi.fn() }));
vi.mock('../../../../lib/share-store', () => ({ resolveShareToken: vi.fn() }));

const token = 's'.repeat(43);
const page = () => SharedConversationPage({ params: Promise.resolve({ token }) });

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAuth).mockReturnValue({
    api: { getSession: vi.fn().mockResolvedValue({ user: { id: 'viewer' } }) },
  } as unknown as ReturnType<typeof getAuth>);
  vi.mocked(resolveShareToken).mockResolvedValue({
    conversation: { id: 'c1', userId: 'owner', title: 'Общий диалог', archivedAt: null },
    messages: [
      { id: 'm1', role: 'user', content: 'вопрос', status: 'done' },
      { id: 'm2', role: 'assistant', content: 'ответ', status: 'done' },
    ],
    total: 2,
    has_more: false,
  } as never);
});

describe('shared conversation page', () => {
  it('redirects a guest to login with a return path', async () => {
    vi.mocked(getAuth).mockReturnValue({
      api: { getSession: vi.fn().mockResolvedValue(null) },
    } as unknown as ReturnType<typeof getAuth>);
    await expect(page()).rejects.toThrow(`redirect:/login?next=${encodeURIComponent(`/share/${token}`)}`);
    expect(redirect).toHaveBeenCalled();
    expect(resolveShareToken).not.toHaveBeenCalled();
  });

  it('renders a 404 for an invalid, expired or revoked token', async () => {
    vi.mocked(resolveShareToken).mockResolvedValue(null);
    await expect(page()).rejects.toThrow('notFound');
    expect(notFound).toHaveBeenCalled();
  });

  it('renders the conversation read-only for a signed-in viewer', async () => {
    const view = render(await page());
    expect(screen.getByText('Общий диалог')).toBeTruthy();
    expect(screen.getByText('вопрос')).toBeTruthy();
    expect(screen.getByText('ответ')).toBeTruthy();
    expect(view.container.textContent).toContain('только для вошедших');
    expect(resolveShareToken).toHaveBeenCalledWith(token);
  });

  it('warns when only the latest page of a long dialog is shown', async () => {
    vi.mocked(resolveShareToken).mockResolvedValue({
      conversation: { id: 'c1', userId: 'owner', title: 'Длинный диалог', archivedAt: null },
      messages: [{ id: 'm500', role: 'user', content: 'последний', status: 'done' }],
      total: 501,
      has_more: true,
    } as never);
    render(await page());
    expect(screen.getByText('Показаны последние 1 из 501 сообщений.')).toBeTruthy();
    expect(screen.getByText('Диалог с Нейрой · 501 сообщений')).toBeTruthy();
  });
});
