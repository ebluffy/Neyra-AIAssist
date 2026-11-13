import React, { type InputHTMLAttributes, forwardRef, useId } from 'react';

export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
  hint?: string;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(
  ({ label, error, hint, id, disabled, required, className = '', ...props }, ref) => {
    const generatedId = useId();
    const inputId = id ?? generatedId;
    const errorId = `${inputId}-error`;
    const hintId = `${inputId}-hint`;

    const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ') || undefined;

    return (
      <div className="flex flex-col gap-1.5 w-full text-left">
        <label htmlFor={inputId} className="text-xs font-medium text-[var(--text-muted)] select-none">
          {label} {required && <span className="text-[var(--accent)]" aria-hidden="true">*</span>}
        </label>
        <input
          ref={ref}
          id={inputId}
          disabled={disabled}
          required={required}
          aria-invalid={!!error}
          aria-describedby={describedBy}
          className={`h-11 w-full rounded-[var(--radius)] bg-[var(--surface-2)] px-3.5 text-sm text-[var(--text)] placeholder-[var(--text-subtle)] border ${
            error
              ? 'border-[var(--danger)] focus:border-[var(--danger)]'
              : 'border-[var(--border)] focus:border-[var(--accent)]'
          } outline-none transition-colors disabled:opacity-40 disabled:cursor-default ${className}`}
          {...props}
        />
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
