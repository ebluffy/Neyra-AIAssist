// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AuthForm } from './auth-form';
import { signIn } from '../../lib/auth-client';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock('../../lib/auth-client', () => ({
  signIn: { email: vi.fn() },
  signUp: { email: vi.fn() },
}));

afterEach(cleanup);

const config = { authMode: 'password' as const, inviteRequired: false, discordAvailable: false };

describe('AuthForm password visibility', () => {
  it('shows a toggle on the login password field', () => {
    render(<AuthForm mode="login" config={config} />);
    const input = screen.getByLabelText(/Пароль/) as HTMLInputElement;
    expect(input.getAttribute('type')).toBe('password');

    fireEvent.click(screen.getByRole('button', { name: 'Показать пароль' }));
    expect(input.getAttribute('type')).toBe('text');
    expect(screen.getByRole('button', { name: 'Скрыть пароль' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('shows a toggle on the signup password field too', () => {
    render(<AuthForm mode="signup" config={{ ...config, inviteRequired: true }} invite="token-1" />);
    const input = screen.getByLabelText(/Пароль/) as HTMLInputElement;
    expect(input.getAttribute('type')).toBe('password');
    fireEvent.click(screen.getByRole('button', { name: 'Показать пароль' }));
    expect(input.getAttribute('type')).toBe('text');
  });
});

describe('AuthForm invite gate (AR-67)', () => {
  const inviteConfig = { authMode: 'password' as const, inviteRequired: true, discordAvailable: false };

  it('does not ask for an invite code on login', () => {
    render(<AuthForm mode="login" config={inviteConfig} registrationMode="invite" />);
    expect(screen.queryByLabelText(/Код приглашения/)).toBeNull();
    expect(screen.queryByText(/Для входа требуется код приглашения/)).toBeNull();
  });

  it('signs in without an invite code even when the invite mode is on', async () => {
    const signInEmail = vi.mocked(signIn.email);
    signInEmail.mockResolvedValue({} as never);
    render(<AuthForm mode="login" config={inviteConfig} registrationMode="invite" />);

    fireEvent.change(screen.getByLabelText(/Email/), { target: { value: 'user@example.test' } });
    fireEvent.change(screen.getByLabelText(/Пароль/), { target: { value: 'correct-horse-battery' } });
    fireEvent.click(screen.getByRole('button', { name: 'Войти' }));

    await vi.waitFor(() => expect(signInEmail).toHaveBeenCalledTimes(1));
    expect(signInEmail.mock.calls[0][0]).toEqual({ email: 'user@example.test', password: 'correct-horse-battery' });
    expect(screen.queryByText(/код приглашения/i)).toBeNull();
  });

  it('still asks for an invite code on signup', () => {
    render(<AuthForm mode="signup" config={inviteConfig} registrationMode="invite" />);
    expect(screen.getByLabelText(/Код приглашения/)).toBeTruthy();
  });
});
