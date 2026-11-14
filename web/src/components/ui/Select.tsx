'use client';

import React, { forwardRef, type SelectHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
  hint?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ label, error, hint, disabled, className = '', id, children, ...props }, ref) => {
    return (
      <div className="flex flex-col gap-1.5 w-full text-left">
        {label && (
          <label htmlFor={id} className="text-xs font-medium text-[var(--text-muted)] select-none">
            {label}
          </label>
        )}
        <div className="relative w-full">
          <select
            ref={ref}
            id={id}
            disabled={disabled}
            className={`h-11 w-full appearance-none rounded-[var(--radius)] bg-[var(--surface-2)] pl-3.5 pr-10 text-sm text-[var(--text)] border ${
              error
                ? 'border-[var(--danger)] focus:border-[var(--danger)] focus:ring-2 focus:ring-[var(--danger)]/40'
                : 'border-[var(--border-control)] focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)]/30'
            } outline-none transition-all disabled:opacity-40 disabled:cursor-default ${className}`}
            {...props}
          >
            {children}
          </select>
          <ChevronDown
            size={16}
            className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]"
            aria-hidden="true"
          />
        </div>
        {error ? (
          <p role="alert" className="text-xs text-[var(--danger)]">
            {error}
          </p>
        ) : hint ? (
          <p className="text-xs text-[var(--text-subtle)]">
            {hint}
          </p>
        ) : null}
      </div>
    );
  }
);

Select.displayName = 'Select';
