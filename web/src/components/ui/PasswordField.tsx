'use client';

import React, { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { TextField, type TextFieldProps } from './TextField';

// Поле пароля с кнопкой «показать/скрыть». Кнопка внутри поля, чтобы
// переключение не сдвигало вёрстку; значение и aria-атрибуты не меняются.
export function PasswordField({ disabled, ...props }: TextFieldProps) {
  const [visible, setVisible] = useState(false);
  const label = visible ? 'Скрыть пароль' : 'Показать пароль';

  return (
    <TextField
      {...props}
      disabled={disabled}
      type={visible ? 'text' : 'password'}
      trailing={
        <button
          type="button"
          onClick={() => setVisible(current => !current)}
          disabled={disabled}
          aria-label={label}
          aria-pressed={visible}
          className="absolute right-1.5 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-[var(--radius)] text-[var(--text-subtle)] transition-colors hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface-2)] disabled:opacity-40 disabled:cursor-default"
        >
          {visible ? (
            <EyeOff size={18} strokeWidth={1.5} aria-hidden="true" />
          ) : (
            <Eye size={18} strokeWidth={1.5} aria-hidden="true" />
          )}
        </button>
      }
    />
  );
}
