import React from 'react';

export interface AvatarProps {
  name?: string | null;
  email?: string | null;
  size?: number;
  className?: string;
}

export function Avatar({ name, email, size = 24, className = '' }: AvatarProps) {
  const display = (name || email || 'U').trim();
  const initial = display.charAt(0).toUpperCase();

  return (
    <div
      style={{ width: size, height: size, minWidth: size }}
      className={`inline-flex items-center justify-center rounded-[var(--radius-full)] bg-[var(--surface-3)] border border-[var(--border)] text-[var(--text)] font-semibold select-none text-[11px] ${className}`}
      aria-hidden="true"
    >
      {initial}
    </div>
  );
}
