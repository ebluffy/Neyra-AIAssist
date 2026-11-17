'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Webhook, Plus } from 'lucide-react';
import { WebhookRow, type WebhookConfig } from '../../../components/ui/WebhookRow';
import { Button } from '../../../components/ui/Button';
import { SoonAction } from '../../../components/ui/SoonAction';
import { isEnabled } from '../../../lib/feature-flags';

export default function AdminWebhooksPage() {
  if (!isEnabled('opsWebhooks')) {
    notFound();
  }

  // В этапе P4 конфигурация вебхуков будет синхронизироваться с ядром через /v1/ops/webhooks.
  const [webhooks] = useState<WebhookConfig[]>([]);

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
              <Webhook size={16} className="text-[var(--accent)]" />
              <span>Событийные вебхуки (Webhooks)</span>
            </h2>
            <p className="text-xs text-[var(--text-muted)]">
              Отправка системных событий ядра во внешние сервисы и системы мониторинга
            </p>
          </div>
        </div>

        <SoonAction actionName="Добавить вебхук">
          <Button variant="primary" size="sm" className="text-xs gap-1.5" disabled>
            <Plus size={14} />
            <span>Добавить вебхук</span>
          </Button>
        </SoonAction>
      </div>

      {webhooks.length === 0 ? (
        <div className="p-8 rounded-[var(--radius)] bg-[var(--surface-2)] border border-[var(--border)] text-center space-y-3 max-w-lg mx-auto">
          <div className="w-10 h-10 rounded-full bg-[var(--surface-3)] text-[var(--text-subtle)] flex items-center justify-center mx-auto">
            <Webhook size={20} />
          </div>
          <div className="space-y-1">
            <h3 className="text-sm font-medium text-[var(--text)]">Вебхуки ядра не настроены</h3>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed">
              Раздел находится в разработке (P4). Регистрация обработчиков событий (user.signup, core.crash)
              будет доступна после интеграции диспетчера вебхуков.
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {webhooks.map((w) => (
            <WebhookRow key={w.id} webhook={w} />
          ))}
        </div>
      )}
    </div>
  );
}
