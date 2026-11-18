import React, { type HTMLAttributes, type ReactNode } from 'react';

export interface KbdProps extends HTMLAttributes<HTMLElement> {
  children: ReactNode;
}

export function Kbd({ children, className = '', ...props }: KbdProps) {
  return (
    <kbd
      className={`inline-flex items-center justify-center px-1.5 py-0.5 text-[10px] font-mono font-medium text-[var(--text-muted)] bg-[var(--surface-3)] border border-[var(--border-control)] rounded-[var(--radius-sm)] shadow-[inset_0_-1px_0_rgba(255,255,255,0.1)] select-none ${className}`}
      {...props}
    >
      {children}
    </kbd>
  );
}
