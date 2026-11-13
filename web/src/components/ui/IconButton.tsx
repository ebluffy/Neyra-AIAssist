import React, { type ButtonHTMLAttributes, forwardRef, type ReactNode } from 'react';

export type IconButtonVariant = 'ghost' | 'secondary' | 'primary';
export type IconButtonSize = 'sm' | 'md' | 'lg';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  'aria-label': string;
  icon: ReactNode;
  variant?: IconButtonVariant;
  size?: IconButtonSize;
  rounded?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  (
    {
      'aria-label': ariaLabel,
      icon,
      variant = 'ghost',
      size = 'md',
      rounded = false,
      disabled,
      className = '',
      type = 'button',
      ...props
    },
    ref
  ) => {
    const baseClasses =
      'inline-flex items-center justify-center transition-all select-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]';

    const variantClasses = {
      primary:
        'bg-[var(--accent)] text-[var(--accent-ink)] hover:bg-[var(--accent-hover)] active:scale-[0.98]',
      secondary:
        'bg-[var(--surface-2)] text-[var(--text)] border border-[var(--border)] hover:bg-[var(--surface-3)] hover:border-[var(--border-strong)] active:scale-[0.98]',
      ghost:
        'bg-transparent text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-3)] active:scale-[0.98]',
    }[variant];

    const sizeClasses = {
      sm: 'w-6 h-6',
      md: 'w-8 h-8',
      lg: 'w-10 h-10',
    }[size];

    const radiusClasses = rounded ? 'rounded-[var(--radius-full)]' : 'rounded-[var(--radius-sm)]';
    const stateClasses = disabled ? 'opacity-40 cursor-default pointer-events-none' : 'cursor-pointer';

    return (
      <button
        ref={ref}
        type={type}
        aria-label={ariaLabel}
        disabled={disabled}
        className={`${baseClasses} ${variantClasses} ${sizeClasses} ${radiusClasses} ${stateClasses} ${className}`}
        {...props}
      >
        {icon}
      </button>
    );
  }
);

IconButton.displayName = 'IconButton';
