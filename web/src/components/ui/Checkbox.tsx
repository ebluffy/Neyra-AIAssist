'use client';

import React, { forwardRef, type InputHTMLAttributes } from 'react';
import { Check } from 'lucide-react';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: string;
  description?: string;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  ({ label, description, checked, disabled, className = '', id, onChange, ...props }, ref) => {
    return (
      <label className="inline-flex items-start gap-2.5 min-h-[44px] cursor-pointer select-none py-1">
        <div className="relative flex items-center justify-center shrink-0 mt-0.5">
          <input
            ref={ref}
            id={id}
            type="checkbox"
            checked={checked}
            disabled={disabled}
            onChange={onChange}
            className="peer sr-only"
            {...props}
          />
          <div
            className={`w-4.5 h-4.5 rounded-[var(--radius-sm)] border transition-all duration-150 flex items-center justify-center peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--accent)] peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-[var(--bg)] ${
              checked
                ? 'bg-[var(--accent)] border-[var(--accent)] text-[var(--accent-ink)]'
                : 'bg-[var(--surface-2)] border-[var(--border-control)] hover:border-[var(--accent)]'
            } ${disabled ? 'opacity-40 cursor-default' : ''} ${className}`}
          >
            {checked && <Check size={12} strokeWidth={2.5} />}
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

Checkbox.displayName = 'Checkbox';
