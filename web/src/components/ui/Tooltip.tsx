'use client';

import React, { useState, type ReactNode } from 'react';

export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
  className?: string;
}

export function Tooltip({
  content,
  children,
  side = 'top',
  className = '',
}: TooltipProps) {
  const [open, setOpen] = useState(false);

  if (!content) {
    return <>{children}</>;
  }

  const positionClasses = {
    top: 'bottom-full left-1/2 -translate-x-1/2 mb-1.5',
    bottom: 'top-full left-1/2 -translate-x-1/2 mt-1.5',
    left: 'right-full top-1/2 -translate-y-1/2 mr-1.5',
    right: 'left-full top-1/2 -translate-y-1/2 ml-1.5',
  }[side];

  return (
    <div
      className={`relative inline-flex items-center ${className}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={(e) => {
        const target = e.target as HTMLElement;
        let keyboardFocus = false;
        try {
          keyboardFocus = typeof target.matches === 'function' && target.matches(':focus-visible');
        } catch {
          keyboardFocus = false;
        }
        if (keyboardFocus) {
          setOpen(true);
        }
      }}
      onBlur={() => setOpen(false)}
    >
      {children}
      {open && (
        <div
          role="tooltip"
          className={`pointer-events-none absolute z-50 whitespace-nowrap rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--surface-3)] px-2 py-1 text-[11px] font-normal leading-none text-[var(--text)] shadow-lg transition-opacity duration-150 ${positionClasses}`}
        >
          {content}
        </div>
      )}
    </div>
  );
}
