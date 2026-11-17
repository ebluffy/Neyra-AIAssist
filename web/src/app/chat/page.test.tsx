import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ChatPage from './page';
import { getAuth } from '../../../lib/auth';
import { getUserOnboardingCompleted } from '../../../lib/admin-users';
import { ChatView } from './chat-view';

// Next собирает JSX автоматическим рантаймом; vitest/esbuild — классическим.
vi.stubGlobal('React', React);

vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));
vi.mock('../../../lib/auth', () => ({ getAuth: vi.fn() }));
vi.mock('../../../lib/admin-users', () => ({ getUserOnboardingCompleted: vi.fn() }));
vi.mock('./chat-view', () => ({ ChatView: vi.fn(() => null) }));

const session = {
  user: { id: 'usr-42', name: 'Алиса', email: 'alice@example.test', role: 'user' },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAuth).mockReturnValue({
    api: { getSession: vi.fn().mockResolvedValue(session) },
  } as unknown as ReturnType<typeof getAuth>);
  vi.mocked(getUserOnboardingCompleted).mockResolvedValue({ ok: true, value: true });
});

describe('ChatPage onboarding gate (AR-80, AR-95)', () => {
  it('redirects a new user on the server before ChatView renders', async () => {
    vi.mocked(getUserOnboardingCompleted).mockResolvedValue({ ok: true, value: false });
    await expect(ChatPage()).rejects.toThrow('NEXT_REDIRECT:/onboarding');
    expect(ChatView).not.toHaveBeenCalled();
  });

  it('renders chat for a user who completed onboarding', async () => {
    const result = (await ChatPage()) as React.ReactElement<{ user: typeof session.user }>;
    expect(result).toBeTruthy();
    expect(result.props.user).toEqual(session.user);
  });

  it('keeps chat available when the onboarding read fails', async () => {
    vi.mocked(getUserOnboardingCompleted).mockResolvedValue({ ok: false, error: 'db' });
    const result = (await ChatPage()) as React.ReactElement<{ user: typeof session.user }>;
    expect(result.props.user).toEqual(session.user);
  });

  it('redirects to login without a session', async () => {
    vi.mocked(getAuth).mockReturnValue({
      api: { getSession: vi.fn().mockResolvedValue(null) },
    } as unknown as ReturnType<typeof getAuth>);
    await expect(ChatPage()).rejects.toThrow('NEXT_REDIRECT:/login');
    expect(ChatView).not.toHaveBeenCalled();
  });
});
