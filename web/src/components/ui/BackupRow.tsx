'use client';

import React from 'react';
import { Database, Download, RotateCcw, Trash2 } from 'lucide-react';
import { Button } from './Button';
import { Tooltip } from './Tooltip';

export interface BackupItem {
  id: string;
  filename: string;
  sizeBytes: number;
  createdAt: string;
  type: 'auto' | 'manual';
  scope?: string;
}

export interface BackupRowProps {
  backup: BackupItem;
  onDownload?: (id: string) => void;
  onRestore?: (id: string) => void;
  onDelete?: (id: string) => void;
  restoring?: boolean;
  className?: string;
}

export function BackupRow({
  backup,
  onDownload,
  onRestore,
  onDelete,
  restoring = false,
  className = '',
}: BackupRowProps) {
  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} Б`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
  };

  const formattedDate = new Date(backup.createdAt).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div
      className={`p-3.5 rounded-[var(--radius)] bg-[var(--surface-2)] border border-[var(--border-control)] flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${className}`}
    >
      <div className="space-y-1 min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Database size={14} className="text-[var(--text-subtle)] shrink-0" />
          <span className="text-xs font-mono text-[var(--text)] truncate max-w-sm font-medium">
            {backup.filename}
          </span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--surface-3)] text-[var(--text-subtle)] border border-[var(--border)]">
            {backup.type === 'auto' ? 'Автоматический' : 'Ручной'}
          </span>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-[var(--text-subtle)]">
          <span>{formattedDate}</span>
          <span>·</span>
          <span>{formatSize(backup.sizeBytes)}</span>
          {backup.scope && <span>· Область: {backup.scope}</span>}
        </div>
      </div>

      <div className="flex items-center gap-1.5 shrink-0 self-end sm:self-center">
        {onDownload && (
          <Tooltip content="Скачать файл бэкапа">
            <button
              type="button"
              onClick={() => onDownload(backup.id)}
              aria-label="Скачать бэкап"
              className="p-1.5 rounded-[var(--radius-sm)] text-[var(--text-subtle)] hover:text-[var(--text)] hover:bg-[var(--surface-3)] transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
            >
              <Download size={13} />
            </button>
          </Tooltip>
        )}
        {onRestore && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onRestore(backup.id)}
            loading={restoring}
            disabled={restoring}
            className="text-xs h-7 px-2.5"
          >
            <RotateCcw size={11} className="mr-1" />
            Восстановить
          </Button>
        )}
        {onDelete && (
          <Tooltip content="Удалить бэкап">
            <button
              type="button"
              onClick={() => onDelete(backup.id)}
              aria-label="Удалить бэкап"
              className="p-1.5 rounded-[var(--radius-sm)] text-[var(--text-subtle)] hover:text-[var(--danger)] hover:bg-[var(--danger-quiet)] transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--danger)]"
            >
              <Trash2 size={13} />
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  );
}
