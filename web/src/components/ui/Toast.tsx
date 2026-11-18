'use client';

import React, { type ReactNode } from 'react';
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';
import { IconButton } from './IconButton';

export interface ToastProps {
  open: boolean;
  onClose: () => void;
  tone?: 'info' | 'success' | 'danger';
  title?: string;
  message: ReactNode;
  action?: ReactNode;
}

export function Toast({
  open,
  onClose,
  tone = 'info',
  title,
  message,
  action,
}: ToastProps) {
  if (!open) return null;

  const icons = {
    info: <Info size={16} className="text-[var(--text-muted)] shrink-0" />,
    success: <CheckCircle2 size={16} className="text-[var(--success)] shrink-0" />,
    danger: <AlertCircle size={16} className="text-[var(--danger)] shrink-0" />,
  }[tone];

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 right-4 z-50 flex items-start gap-3 p-3.5 max-w-sm rounded-[var(--radius)] bg-[var(--surface-2)] border border-[var(--border-control)] shadow-[var(--shadow-panel)] text-[var(--text)] animate-in fade-in slide-in-from-bottom-2 duration-150"
    >
      <div className="mt-0.5">{icons}</div>
      <div className="flex-1 min-w-0">
        {title && <h5 className="text-xs font-semibold text-[var(--text)]">{title}</h5>}
        <div className="text-xs text-[var(--text-muted)] mt-0.5 leading-relaxed">{message}</div>
        {action && <div className="mt-2">{action}</div>}
      </div>
      <IconButton
        icon={<X size={14} />}
        aria-label="Закрыть уведомление"
        variant="ghost"
        size="sm"
        onClick={onClose}
      />
    </div>
  );
}
