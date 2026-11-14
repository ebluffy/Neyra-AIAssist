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
          className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center justify-center p-1.5 rounded-[var(--radius-sm)] text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-3)]/60 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)] disabled:opacity-40 disabled:cursor-default cursor-pointer"
        >
          {visible ? (
            <EyeOff size={16} strokeWidth={1.75} aria-hidden="true" />
          ) : (
            <Eye size={16} strokeWidth={1.75} aria-hidden="true" />
          )}
        </button>
      }
    />
  );
}
