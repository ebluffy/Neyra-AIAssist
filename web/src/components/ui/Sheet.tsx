'use client';

import React, { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { IconButton } from './IconButton';

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  side?: 'left' | 'right' | 'bottom';
  className?: string;
}

export function Sheet({
  open,
  onClose,
  title,
  children,
  side = 'left',
  className = '',
}: SheetProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    panelRef.current?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };

    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  const sideClasses = {
    left: 'inset-y-0 left-0 w-full max-w-xs border-r',
    right: 'inset-y-0 right-0 w-full max-w-xs border-l',
    bottom: 'inset-x-0 bottom-0 max-h-[85dvh] border-t rounded-t-[var(--radius-lg)]',
  }[side];

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className={`fixed flex flex-col bg-[var(--surface)] text-[var(--text)] border-[var(--border-strong)] shadow-[var(--shadow-panel)] outline-none ${sideClasses} ${className}`}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)] shrink-0">
          <div className="font-medium text-sm text-[var(--text)]">{title}</div>
          <IconButton
            icon={<X size={16} />}
            aria-label="Закрыть панель"
            variant="ghost"
            size="sm"
            onClick={onClose}
          />
        </div>
        <div className="flex-1 overflow-y-auto p-4 min-h-0">
          {children}
        </div>
      </div>
    </div>
  );
}
