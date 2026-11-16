'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Webhook, Plus } from 'lucide-react';
import { WebhookRow, type WebhookConfig } from '../../../components/ui/WebhookRow';
import { Button } from '../../../components/ui/Button';
import { emitToast } from '../../../lib/toast';

const INITIAL_WEBHOOKS: WebhookConfig[] = [
  {
    id: 'wh-1',
    url: 'https://api.internal.local/hooks/audit',
    events: ['user.signup', 'user.ban'],
    active: true,
    lastTriggerAt: new Date(Date.now() - 3600000).toISOString(),
    lastStatus: 200,
  },
  {
    id: 'wh-2',
    url: 'https://alert.internal.local/v1/core-events',
    events: ['core.crash', 'provider.error'],
    active: true,
    lastTriggerAt: new Date(Date.now() - 86400000).toISOString(),
    lastStatus: 200,
  },
];

export default function AdminWebhooksPage() {
  const [webhooks, setWebhooks] = useState<WebhookConfig[]>(INITIAL_WEBHOOKS);
  const [testingId, setTestingId] = useState<string | null>(null);

  const handleTest = (id: string) => {
    setTestingId(id);
    setTimeout(() => {
      setTestingId(null);
      emitToast({ message: 'Тестовый запрос успешно доставлен (HTTP 200)', tone: 'success' });
    }, 600);
  };

  const handleDelete = (id: string) => {
    setWebhooks((prev) => prev.filter((w) => w.id !== id));
    emitToast({ message: 'Вебхук удалён', tone: 'info' });
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
              <Webhook size={16} className="text-[var(--accent)]" />
              <span>Событийные вебхуки (Webhooks)</span>
            </h2>
            <p className="text-xs text-[var(--text-muted)]">
              Отправка системных уведомлений о событиях ядра на внешние эндпоинты
            </p>
          </div>
        </div>

        <Button
          variant="secondary"
          size="sm"
          onClick={() => emitToast({ message: 'Скоро: форма создания вебхука', tone: 'info' })}
          className="text-xs gap-1.5"
        >
          <Plus size={13} />
          <span>Добавить вебхук</span>
        </Button>
      </div>

      <div className="space-y-3">
        {webhooks.length > 0 ? (
          webhooks.map((wh) => (
            <WebhookRow
              key={wh.id}
              webhook={wh}
              onTest={handleTest}
              onDelete={handleDelete}
              testing={testingId === wh.id}
            />
          ))
        ) : (
          <div className="p-8 text-center rounded-[var(--radius)] bg-[var(--surface-2)] border border-[var(--border)] text-xs text-[var(--text-muted)]">
            Нет активных вебхуков
          </div>
        )}
      </div>
    </div>
  );
}
