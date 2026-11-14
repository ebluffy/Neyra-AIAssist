import React, { type InputHTMLAttributes, type ReactNode, forwardRef, useId } from 'react';

export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
  hint?: string;
  // Кнопка/иконка внутри поля справа (показать пароль и т.п.).
  trailing?: ReactNode;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(
  ({ label, error, hint, id, disabled, required, className = '', trailing, ...props }, ref) => {
    const generatedId = useId();
    const inputId = id ?? generatedId;
    const errorId = `${inputId}-error`;
    const hintId = `${inputId}-hint`;

    const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ') || undefined;

    return (
      <div className="flex flex-col gap-1.5 w-full text-left">
        <label htmlFor={inputId} className="flex items-baseline gap-1 text-xs font-medium text-[var(--text-muted)] select-none">
          <span className="inline-flex items-baseline gap-1">
            <span>{label}</span>
            {required && (
              <span className="text-[var(--accent)] font-semibold" aria-hidden="true">
                *
              </span>
            )}
          </span>
        </label>
        <div className="relative w-full">
          <input
            ref={ref}
            id={inputId}
            disabled={disabled}
            required={required}
            aria-invalid={!!error}
            aria-describedby={describedBy}
            className={`h-11 w-full rounded-[var(--radius)] bg-[var(--surface-2)] px-3.5 text-sm text-[var(--text)] placeholder-[var(--text-subtle)] border ${
              error
                ? 'border-[var(--danger)] focus:border-[var(--danger)] focus:ring-2 focus:ring-[var(--danger)]/40'
                : 'border-[var(--border)] focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)]/30'
            } outline-none transition-all disabled:opacity-40 disabled:cursor-default ${trailing ? 'pr-12' : ''} ${className}`}
            {...props}
          />
          {trailing}
        </div>
        {error ? (
          <p id={errorId} role="alert" className="text-xs text-[var(--danger)]">
            {error}
          </p>
        ) : hint ? (
          <p id={hintId} className="text-xs text-[var(--text-subtle)]">
            {hint}
          </p>
        ) : null}
      </div>
    );
  }
);

TextField.displayName = 'TextField';
