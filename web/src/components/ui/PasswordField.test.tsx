// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PasswordField } from './PasswordField';

afterEach(cleanup);

function setup(props: Partial<React.ComponentProps<typeof PasswordField>> = {}) {
  render(<PasswordField label="Пароль" name="password" {...props} />);
  const input = screen.getByLabelText('Пароль') as HTMLInputElement;
  return { input };
}

describe('PasswordField', () => {
  it('is masked by default', () => {
    const { input } = setup();
    expect(input.getAttribute('type')).toBe('password');
    expect(screen.getByRole('button', { name: 'Показать пароль' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('toggles to text and back without losing the value', () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: 'секрет-123' } });

    fireEvent.click(screen.getByRole('button', { name: 'Показать пароль' }));
    expect(input.getAttribute('type')).toBe('text');
    expect(input.value).toBe('секрет-123');

    const hide = screen.getByRole('button', { name: 'Скрыть пароль' });
    expect(hide.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(hide);
    expect(input.getAttribute('type')).toBe('password');
    expect(input.value).toBe('секрет-123');
  });

  it('does not submit the form', () => {
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <PasswordField label="Пароль" name="password" />
      </form>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Показать пароль' }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('keeps aria-invalid and aria-describedby through the toggle', () => {
    const { input } = setup({ error: 'Слишком короткий пароль' });
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const described = input.getAttribute('aria-describedby');
    expect(described).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Слишком короткий пароль');

    fireEvent.click(screen.getByRole('button', { name: 'Показать пароль' }));
    expect(input.getAttribute('type')).toBe('text');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe(described);
  });

  it('disables the toggle together with the field', () => {
    setup({ disabled: true });
    expect((screen.getByRole('button', { name: 'Показать пароль' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
