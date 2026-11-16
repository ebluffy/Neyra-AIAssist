'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Database, Plus, RefreshCw } from 'lucide-react';
import { BackupRow, type BackupItem } from '../../../components/ui/BackupRow';
import { Button } from '../../../components/ui/Button';
import { emitToast } from '../../../lib/toast';

const INITIAL_BACKUPS: BackupItem[] = [
  {
    id: 'bk-1',
    filename: 'neyra-core-backup-2026-11-15.tar.gz',
    sizeBytes: 14500000,
    createdAt: new Date(Date.now() - 86400000).toISOString(),
    type: 'auto',
    scope: 'полный срез (БД + память)',
  },
  {
    id: 'bk-2',
    filename: 'neyra-core-backup-2026-11-14.tar.gz',
    sizeBytes: 14100000,
    createdAt: new Date(Date.now() - 172800000).toISOString(),
    type: 'auto',
    scope: 'полный срез (БД + память)',
  },
];

export default function AdminBackupsPage() {
  const [backups, setBackups] = useState<BackupItem[]>(INITIAL_BACKUPS);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const handleDownload = (id: string) => {
    emitToast({ message: `Скачивание архива ${id}...`, tone: 'info' });
  };

  const handleRestore = (id: string) => {
    setRestoringId(id);
    setTimeout(() => {
      setRestoringId(null);
      emitToast({ message: 'Резервная копия проверена и готова к восстановлению', tone: 'success' });
    }, 800);
  };

  const handleDelete = (id: string) => {
    setBackups((prev) => prev.filter((b) => b.id !== id));
    emitToast({ message: 'Бэкап удален', tone: 'info' });
  };

  const handleCreate = () => {
    emitToast({ message: 'Запущен процесс создания резервной копии ядра...', tone: 'info' });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link
            href="/chat?settings=system"
            className="p-1.5 rounded-[var(--radius-sm)] text-[var(--text-subtle)] hover:text-[var(--text)] hover:bg-[var(--surface-2)] transition-colors"
            aria-label="Назад в админку"
          >
            <ArrowLeft size={16} />
          </Link>
          <div>
            <h2 className="text-sm font-semibold tracking-tight text-[var(--text)] flex items-center gap-2">
              <Database size={16} className="text-[var(--accent)]" />
              <span>Резервные копии ядра (Backups)</span>
            </h2>
            <p className="text-xs text-[var(--text-muted)]">
              Снимки базы данных, индексов долговременной памяти и конфигурации
            </p>
          </div>
        </div>

        <Button
          variant="primary"
          size="sm"
          onClick={handleCreate}
          className="text-xs gap-1.5"
        >
          <Plus size={13} />
          <span>Создать бэкап сейчас</span>
        </Button>
      </div>

      <div className="space-y-3">
        {backups.map((b) => (
          <BackupRow
            key={b.id}
            backup={b}
            onDownload={handleDownload}
            onRestore={handleRestore}
            onDelete={handleDelete}
            restoring={restoringId === b.id}
          />
        ))}
      </div>
    </div>
  );
}
