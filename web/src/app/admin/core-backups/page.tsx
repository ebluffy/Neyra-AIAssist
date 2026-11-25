'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Database, Plus } from 'lucide-react';
import { BackupRow, type BackupItem } from '../../../components/ui/BackupRow';
import { Button } from '../../../components/ui/Button';
import { SoonAction } from '../../../components/ui/SoonAction';
import { isEnabled } from '../../../lib/feature-flags';

export default function AdminBackupsPage() {
  if (!isEnabled('opsBackups')) {
    notFound();
  }

  // В этапе P4 снимки базы и долговременной памяти будут управляться через /v1/ops/backups.
  const [backups] = useState<BackupItem[]>([]);

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
              <span>Резервные копии ядра (Core Backups)</span>
            </h2>
            <p className="text-xs text-[var(--text-muted)]">
              Создание полных срезов состояния ядра (БД SQLite + долговременная память) и восстановление
            </p>
          </div>
        </div>

        <SoonAction actionName="Создать резервную копию">
          <Button variant="primary" size="sm" className="text-xs gap-1.5" disabled>
            <Plus size={14} />
            <span>Создать бэкап</span>
          </Button>
        </SoonAction>
      </div>

      {backups.length === 0 ? (
        <div className="p-8 rounded-[var(--radius)] bg-[var(--surface-2)] border border-[var(--border)] text-center space-y-3 max-w-lg mx-auto">
          <div className="w-10 h-10 rounded-full bg-[var(--surface-3)] text-[var(--text-subtle)] flex items-center justify-center mx-auto">
            <Database size={20} />
          </div>
          <div className="space-y-1">
            <h3 className="text-sm font-medium text-[var(--text)]">Резервные копии не найдены</h3>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed">
              Раздел находится в разработке (P4). Механизм автоматических снимков состояния и восстановления
              будет подключен к сервису обслуживания БД ядра.
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {backups.map((b) => (
            <BackupRow key={b.id} backup={b} />
          ))}
        </div>
      )}
    </div>
  );
}
