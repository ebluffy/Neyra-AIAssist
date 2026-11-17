'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Cpu, RefreshCw, AlertCircle } from 'lucide-react';
import { ModuleCard, type ModuleInfo } from '../../../components/ui/ModuleCard';
import { Button } from '../../../components/ui/Button';
import { SoonAction } from '../../../components/ui/SoonAction';
import { isEnabled } from '../../../lib/feature-flags';

export default function AdminModulesPage() {
  if (!isEnabled('opsModules')) {
    notFound();
  }

  // В этапе P4 модули подключаются к ядру neyra-core через /v1/ops/modules.
  // До реализации ручки ядра данные не симулируются.
  const [modules] = useState<ModuleInfo[]>([]);

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
              <Cpu size={16} className="text-[var(--accent)]" />
              <span>Подсистемы ядра (Ops Modules)</span>
            </h2>
            <p className="text-xs text-[var(--text-muted)]">
              Управление активными модулями и мониторинг состояния сервисов ядра neyra-core
            </p>
          </div>
        </div>

        <SoonAction actionName="Проверить статус модулей">
          <Button variant="secondary" size="sm" className="text-xs gap-1.5" disabled>
            <RefreshCw size={13} />
            <span>Проверить статус</span>
          </Button>
        </SoonAction>
      </div>

      {modules.length === 0 ? (
        <div className="p-8 rounded-[var(--radius)] bg-[var(--surface-2)] border border-[var(--border)] text-center space-y-3 max-w-lg mx-auto">
          <div className="w-10 h-10 rounded-full bg-[var(--surface-3)] text-[var(--text-subtle)] flex items-center justify-center mx-auto">
            <Cpu size={20} />
          </div>
          <div className="space-y-1">
            <h3 className="text-sm font-medium text-[var(--text)]">Модули ядра не подключены</h3>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed">
              Раздел находится в разработке (P4). Мониторинг подсистем (STT, TTS, Vision, Scheduler)
              будет подключен после стабилизации API ядра.
            </p>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {modules.map((m) => (
            <ModuleCard key={m.id} module={m} />
          ))}
        </div>
      )}
    </div>
  );
}
