'use client';

import React, { useState, useRef, useLayoutEffect, useEffect, type ReactNode } from 'react';

export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
  className?: string;
  delayMs?: number;
}

export function Tooltip({
  content,
  children,
  side = 'top',
  className = '',
  delayMs = 150,
}: TooltipProps) {
  const [open, setOpen] = useState(false);
  const [offsetStyle, setOffsetStyle] = useState<React.CSSProperties>({});
  const tipRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setOpen(true), delayMs);
  };

  const hide = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setOpen(false);
  };

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  // Edge clamping: ensure tooltip never overflows the viewport
  useLayoutEffect(() => {
    if (!open || !tipRef.current) return;

    const tip = tipRef.current;
    const rect = tip.getBoundingClientRect();
    const pad = 8;
    const winWidth = window.innerWidth;
    const winHeight = window.innerHeight;

    let shiftX = 0;
    let shiftY = 0;

    // Check right edge
    if (rect.right > winWidth - pad) {
      shiftX = (winWidth - pad) - rect.right;
    }
    // Check left edge
    if (rect.left + shiftX < pad) {
      shiftX = pad - rect.left;
    }

    // Check bottom edge
    if (rect.bottom > winHeight - pad) {
      shiftY = (winHeight - pad) - rect.bottom;
    }
    // Check top edge
    if (rect.top + shiftY < pad) {
      shiftY = pad - rect.top;
    }

    if (shiftX !== 0 || shiftY !== 0) {
      setOffsetStyle({
        transform: `translate(${shiftX}px, ${shiftY}px)`,
      });
    } else {
      setOffsetStyle({});
    }
  }, [open]);

  if (!content) {
    return <>{children}</>;
  }

  const basePosition = {
    top: 'bottom-full left-1/2 -translate-x-1/2 mb-1.5',
    bottom: 'top-full left-1/2 -translate-x-1/2 mt-1.5',
    left: 'right-full top-1/2 -translate-y-1/2 mr-1.5',
    right: 'left-full top-1/2 -translate-y-1/2 ml-1.5',
  }[side];

  return (
    <div
      ref={triggerRef}
      className={`relative inline-flex items-center ${className}`}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={(e) => {
        const target = e.target as HTMLElement;
        let keyboardFocus = false;
        try {
          keyboardFocus = typeof target.matches === 'function' && target.matches(':focus-visible');
        } catch {
          keyboardFocus = false;
        }
        if (keyboardFocus) {
          show();
        }
      }}
      onBlur={hide}
    >
      {children}
      {open && (
        <div
          ref={tipRef}
          role="tooltip"
          style={offsetStyle}
          className={`pointer-events-none absolute z-50 max-w-[280px] break-words rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--surface-3)] px-2.5 py-1 text-[11px] font-normal leading-normal text-[var(--text)] shadow-lg transition-opacity duration-150 animate-in fade-in duration-100 ${basePosition}`}
        >
          {content}
        </div>
      )}
    </div>
  );
}
