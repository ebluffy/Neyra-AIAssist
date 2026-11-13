'use client';

import React, { type ButtonHTMLAttributes, forwardRef, type ReactNode } from 'react';
import { Tooltip } from './Tooltip';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  tooltip?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', size = 'md', loading = false, disabled, className = '', children, type = 'button', tooltip, ...props }, ref) => {
    const baseClasses =
      'inline-flex items-center justify-center font-medium transition-transform select-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]';

    const variantClasses = {
      primary:
        'bg-[var(--accent)] text-[var(--accent-ink)] hover:bg-[var(--accent-hover)] active:scale-[0.98] shadow-sm',
      secondary:
        'bg-[var(--surface-2)] text-[var(--text)] border border-[var(--border)] hover:bg-[var(--surface-3)] hover:border-[var(--border-strong)] active:scale-[0.98]',
      ghost:
        'bg-transparent text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-3)] active:scale-[0.98]',
      danger:
        'bg-[var(--danger-quiet)] text-[var(--danger)] border border-[var(--danger)] hover:bg-[var(--danger)] hover:text-[var(--bg)] active:scale-[0.98]',
    }[variant];

    const sizeClasses = {
      sm: 'h-8 px-3 text-xs rounded-[var(--radius-sm)] gap-1.5',
      md: 'h-10 px-4 text-sm rounded-[var(--radius)] gap-2',
      lg: 'h-11 px-5 text-sm rounded-[var(--radius)] gap-2',
    }[size];

    const stateClasses = disabled || loading ? 'opacity-40 cursor-default pointer-events-none' : 'cursor-pointer';

    const btn = (
      <button
        ref={ref}
        type={type}
        disabled={disabled || loading}
        className={`${baseClasses} ${variantClasses} ${sizeClasses} ${stateClasses} ${className}`}
        {...props}
      >
        {loading && (
          <svg
            className="animate-spin -ml-0.5 mr-1.5 h-3.5 w-3.5 text-current"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
        )}
        {children}
      </button>
    );

    if (tooltip) {
      return <Tooltip content={tooltip}>{btn}</Tooltip>;
    }
    return btn;
  }
);

Button.displayName = 'Button';
