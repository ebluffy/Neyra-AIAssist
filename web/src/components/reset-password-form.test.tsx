// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ResetPasswordForm } from './reset-password-form';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }),
}));

afterEach(cleanup);

describe('ResetPasswordForm password visibility', () => {
  it('has an independent toggle for each of the two password fields', () => {
    render(<ResetPasswordForm token="token-1" />);

    const toggles = screen.getAllByRole('button', { name: 'Показать пароль' });
    expect(toggles).toHaveLength(2);

    const password = screen.getByLabelText(/Новый пароль/) as HTMLInputElement;
    const repeat = screen.getByLabelText(/Повторите пароль/) as HTMLInputElement;
    expect(password.getAttribute('type')).toBe('password');
    expect(repeat.getAttribute('type')).toBe('password');

    fireEvent.click(toggles[0]);
    expect(password.getAttribute('type')).toBe('text');
    expect(repeat.getAttribute('type')).toBe('password');

    fireEvent.click(toggles[1]);
    expect(repeat.getAttribute('type')).toBe('text');
    expect(screen.getAllByRole('button', { name: 'Скрыть пароль' })).toHaveLength(2);
  });
});
