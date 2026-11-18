import React, { type HTMLAttributes, type ReactNode } from 'react';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: 'default' | 'muted' | 'ok' | 'danger' | 'accent';
  size?: 'sm' | 'md';
  children: ReactNode;
}

export function Badge({
  tone = 'default',
  size = 'md',
  children,
  className = '',
  ...props
}: BadgeProps) {
  const toneClasses = {
    default: 'bg-[var(--surface-3)] text-[var(--text)] border border-[var(--border-control)]',
    muted: 'bg-[var(--surface-2)] text-[var(--text-subtle)] border border-[var(--border-control)]',
    ok: 'bg-[var(--surface-3)] text-[var(--text)] border border-[var(--accent)]/40',
    danger: 'bg-[var(--danger-quiet)] text-[var(--danger)] border border-[var(--danger)]/50',
    accent: 'bg-[var(--accent)] text-[var(--accent-ink)] border border-[var(--accent)]',
  }[tone];

  const sizeClasses = size === 'sm' ? 'text-[10px] px-1.5 py-0.5' : 'text-xs px-2 py-0.5';

  return (
    <span
      className={`inline-flex items-center font-medium rounded-[var(--radius-sm)] select-none ${toneClasses} ${sizeClasses} ${className}`}
      {...props}
    >
      {children}
    </span>
  );
}
