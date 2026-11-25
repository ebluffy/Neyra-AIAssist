import React, { type ReactNode } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { Button } from './Button';

export interface ErrorStateProps {
  title?: string;
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}

export function ErrorState({
  title = 'Произошла ошибка',
  message,
  onRetry,
  retryLabel = 'Повторить попытку',
  className = '',
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={`flex flex-col items-center justify-center p-6 text-center rounded-[var(--radius)] border border-[var(--danger)]/30 bg-[var(--danger-quiet)] text-[var(--text)] ${className}`}
    >
      <div className="w-9 h-9 rounded-full bg-[var(--danger)]/15 flex items-center justify-center text-[var(--danger)] mb-2.5">
        <AlertCircle size={20} />
      </div>
      <h4 className="text-sm font-semibold text-[var(--text)]">{title}</h4>
      <p className="text-xs text-[var(--danger)] max-w-sm mt-1 leading-relaxed">
        {message}
      </p>
      {onRetry && (
        <Button
          variant="secondary"
          size="sm"
          onClick={onRetry}
          className="mt-3.5 border-[var(--border-control)]"
        >
          <RefreshCw size={13} className="mr-1.5" />
          {retryLabel}
        </Button>
      )}
    </div>
  );
}
