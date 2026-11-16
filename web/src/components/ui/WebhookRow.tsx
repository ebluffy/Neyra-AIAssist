'use client';

import React from 'react';
import { Webhook, Play, Trash2, Check, AlertCircle } from 'lucide-react';
import { Button } from './Button';
import { Tooltip } from './Tooltip';

export interface WebhookConfig {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  lastTriggerAt?: string;
  lastStatus?: number;
}

export interface WebhookRowProps {
  webhook: WebhookConfig;
  onTest?: (id: string) => void;
  onDelete?: (id: string) => void;
  testing?: boolean;
  className?: string;
}

export function WebhookRow({
  webhook,
  onTest,
  onDelete,
  testing = false,
  className = '',
}: WebhookRowProps) {
  const isHealthy = !webhook.lastStatus || (webhook.lastStatus >= 200 && webhook.lastStatus < 300);

  return (
    <div
      className={`p-3.5 rounded-[var(--radius)] bg-[var(--surface-2)] border border-[var(--border-control)] flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${className}`}
    >
      <div className="space-y-1 min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Webhook size={14} className="text-[var(--text-subtle)] shrink-0" />
          <span className="text-xs font-mono text-[var(--text)] truncate max-w-sm">
            {webhook.url}
          </span>
          {webhook.active ? (
            <span className="text-[10px] px-1.5 py-0.2 rounded bg-emerald-950/40 text-emerald-400 border border-emerald-800/40">
              Активен
            </span>
          ) : (
            <span className="text-[10px] px-1.5 py-0.2 rounded bg-zinc-800 text-zinc-400 border border-zinc-700">
              Отключен
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--text-subtle)]">
          <span>События: {webhook.events.join(', ') || 'все'}</span>
          {webhook.lastTriggerAt && (
            <span>
              · Посл. вызов: {new Date(webhook.lastTriggerAt).toLocaleTimeString('ru-RU')}
            </span>
          )}
          {typeof webhook.lastStatus === 'number' && (
            <span className="flex items-center gap-1">
              · {isHealthy ? <Check size={11} className="text-emerald-400" /> : <AlertCircle size={11} className="text-rose-400" />}
              HTTP {webhook.lastStatus}
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1.5 shrink-0 self-end sm:self-center">
        {onTest && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onTest(webhook.id)}
            loading={testing}
            disabled={testing}
            className="text-xs h-7 px-2.5"
          >
            <Play size={11} className="mr-1" />
            Тест
          </Button>
        )}
        {onDelete && (
          <Tooltip content="Удалить вебхук">
            <button
              type="button"
              onClick={() => onDelete(webhook.id)}
              aria-label="Удалить вебхук"
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
