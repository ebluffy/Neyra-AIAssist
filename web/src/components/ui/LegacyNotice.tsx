'use client';

import React from 'react';
import { AlertTriangle, ExternalLink, ArrowRight } from 'lucide-react';
import { Button } from './Button';

export interface LegacyNoticeProps {
  className?: string;
}

export function LegacyNotice({ className = '' }: LegacyNoticeProps) {
  return (
    <div
      className={`p-6 rounded-[var(--radius)] bg-[var(--surface-2)] border border-[var(--border-control)] space-y-4 max-w-xl mx-auto text-left ${className}`}
    >
      <div className="flex items-center gap-3">
        <div className="p-2.5 rounded-[var(--radius-sm)] bg-amber-500/10 text-amber-400 border border-amber-500/20">
          <AlertTriangle size={20} />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-[var(--text)]">
            Устаревший интерфейс управления (Legacy Dashboard)
          </h3>
          <p className="text-xs text-[var(--text-muted)]">
            Переходный режим миграции согласно плану ВКР §6.1 / §18 (P6)
          </p>
        </div>
      </div>

      <div className="space-y-2 text-xs text-[var(--text-muted)] leading-relaxed">
        <p>
          Предыдущая панель управления (`server/dashboard`) сохраняется для низкоуровневой отладки и технических операций ядра до полного переноса Ops-инструментов в веб (этап P4).
        </p>
        <p>
          В основном веб-интерфейсе Neyra Web v2 уже доступны: каталог провайдеров и моделей, управление доступом, аудит и параметры ядра через системную админ-модалку.
        </p>
      </div>

      <div className="pt-2 flex flex-wrap items-center gap-3 border-t border-[var(--border)]">
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            if (typeof window !== 'undefined') {
              window.location.href = '/chat?settings=system';
            }
          }}
          className="gap-1.5"
        >
          <span>Перейти в панель управления</span>
          <ArrowRight size={13} />
        </Button>
      </div>
    </div>
  );
}
