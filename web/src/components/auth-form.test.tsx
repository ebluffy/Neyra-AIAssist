// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AuthForm } from './auth-form';

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
