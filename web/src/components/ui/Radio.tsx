'use client';

import React, { forwardRef, type InputHTMLAttributes } from 'react';

export interface RadioProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: string;
  description?: string;
}

export const Radio = forwardRef<HTMLInputElement, RadioProps>(
  ({ label, description, checked, disabled, className = '', id, onChange, ...props }, ref) => {
    return (
      <label className="inline-flex items-start gap-2.5 min-h-[44px] cursor-pointer select-none py-1">
        <div className="relative flex items-center justify-center shrink-0 mt-0.5">
          <input
            ref={ref}
            id={id}
            type="radio"
            checked={checked}
            disabled={disabled}
            onChange={onChange}
            className="peer sr-only"
            {...props}
          />
          <div
            className={`w-4.5 h-4.5 rounded-full border transition-all duration-150 flex items-center justify-center peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--accent)] peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-[var(--bg)] ${
              checked
                ? 'border-[var(--accent)] bg-[var(--surface-3)]'
                : 'border-[var(--border-control)] bg-[var(--surface-2)] hover:border-[var(--accent)]'
            } ${disabled ? 'opacity-40 cursor-default' : ''} ${className}`}
          >
            {checked && <div className="w-2 h-2 rounded-full bg-[var(--accent)]" />}
          </div>
        </div>
        {(label || description) && (
          <div className="min-w-0">
            {label && <span className="text-sm font-medium text-[var(--text)] block">{label}</span>}
            {description && <span className="text-xs text-[var(--text-subtle)] block mt-0.5">{description}</span>}
          </div>
        )}
      </label>
    );
  }
);

Radio.displayName = 'Radio';
