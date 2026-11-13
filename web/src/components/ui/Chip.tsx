import React, { type ButtonHTMLAttributes, forwardRef } from 'react';

export interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {}

export const Chip = forwardRef<HTMLButtonElement, ChipProps>(({ className = '', children, type = 'button', ...props }, ref) => {
  return (
    <button
      ref={ref}
      type={type}
      className={`inline-flex items-center gap-2 rounded-[var(--radius-full)] border border-[var(--border)] bg-[var(--surface-2)] px-3.5 py-1.5 text-xs text-[var(--text)] transition-[background-color,border-color,transform,color] hover:border-[var(--border-strong)] hover:bg-[var(--surface-3)] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)] cursor-pointer text-left ${className}`}
      {...props}
    >
      {children}
    </button>
  );
});

Chip.displayName = 'Chip';
