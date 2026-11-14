'use client';

import React, { forwardRef, type ButtonHTMLAttributes } from 'react';

export interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  size?: 'sm' | 'md' | 'lg';
  description?: string;
}

export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(
  ({ checked, onChange, label, description, size = 'md', disabled, className = '', id, ...props }, ref) => {
    const sizeClasses = {
      sm: {
        track: 'h-5 w-9',
        thumb: 'h-3.5 w-3.5 top-[2px] left-[2px]',
        translate: 'translate-x-4',
      },
      md: {
        track: 'h-6 w-11',
        thumb: 'h-4.5 w-4.5 top-[2px] left-[2px]',
        translate: 'translate-x-5',
      },
      lg: {
        track: 'h-7 w-13',
        thumb: 'h-5.5 w-5.5 top-[2px] left-[2px]',
        translate: 'translate-x-6',
      },
    }[size];

    const toggle = () => {
      if (!disabled) {
        onChange(!checked);
      }
    };

    const buttonElement = (
      <button
        ref={ref}
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={toggle}
        className={`relative inline-flex shrink-0 cursor-pointer items-center rounded-full border transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)] disabled:opacity-40 disabled:cursor-default ${
          sizeClasses.track
        } ${
          checked
            ? 'bg-[var(--accent)] border-[var(--accent)]'
            : 'bg-[var(--surface-3)] border-[var(--border-control)] hover:border-[var(--accent)]'
        } ${className}`}
        {...props}
      >
        <span
          className={`pointer-events-none absolute rounded-full transition-transform duration-150 ease-out ${
            sizeClasses.thumb
          } ${
            checked
              ? `${sizeClasses.translate} bg-[var(--accent-ink)]`
              : 'translate-x-0 bg-[var(--text-muted)]'
          }`}
        />
      </button>
    );

    if (label || description) {
      return (
        <label className="flex items-center justify-between gap-3 min-h-[44px] cursor-pointer select-none">
          <div className="min-w-0">
            {label && <span className="text-sm font-medium text-[var(--text)] block">{label}</span>}
            {description && <span className="text-xs text-[var(--text-subtle)] block mt-0.5">{description}</span>}
          </div>
          {buttonElement}
        </label>
      );
    }

    return (
      <div className="flex items-center justify-center min-h-[44px] min-w-[44px]">
        {buttonElement}
      </div>
    );
  }
);

Switch.displayName = 'Switch';
