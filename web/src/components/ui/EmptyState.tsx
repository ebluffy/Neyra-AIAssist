import React, { type ReactNode } from 'react';

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className = '',
}: EmptyStateProps) {
  return (
    <div className={`flex flex-col items-center justify-center p-8 text-center rounded-[var(--radius)] border border-dashed border-[var(--border-strong)] bg-[var(--surface)]/50 ${className}`}>
      {icon && <div className="text-[var(--text-muted)] mb-3">{icon}</div>}
      <h3 className="text-sm font-semibold text-[var(--text)]">{title}</h3>
      {description && (
        <p className="text-xs text-[var(--text-muted)] max-w-sm mt-1 leading-relaxed">
          {description}
        </p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
