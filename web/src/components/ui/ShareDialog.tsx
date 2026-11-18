'use client';

import React, { useState } from 'react';
import { Share2, Copy, Check, Lock } from 'lucide-react';
import { Dialog } from './Dialog';
import { Button } from './Button';
import { Select } from './Select';
import { SoonAction } from './SoonAction';
import { emitToast } from '../../lib/toast';

export interface ShareDialogProps {
  open: boolean;
  onClose: () => void;
  threadId: string;
  threadTitle?: string;
  shareUrl?: string | null;
  onRequestShare?: (options: { ttl: '24h' | '7d' | '30d' | 'never'; access: 'auth' | 'public' }) => void;
  loading?: boolean;
}

export function ShareDialog({
  open,
  onClose,
  threadId,
  threadTitle = 'Диалог с Нейрой',
  shareUrl,
  onRequestShare,
  loading = false,
}: ShareDialogProps) {
  const [copied, setCopied] = useState(false);
  const [ttl, setTtl] = useState<'24h' | '7d' | '30d' | 'never'>('7d');
  const [access, setAccess] = useState<'auth' | 'public'>('auth');

  const handleCopy = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      emitToast({ message: 'Ссылка скопирована в буфер обмена', tone: 'success' });
      setTimeout(() => setCopied(false), 2000);
    } catch {
      emitToast({ message: 'Не удалось скопировать ссылку', tone: 'danger' });
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Поделиться диалогом"
      description={`Создание ссылки для просмотра диалога «${threadTitle}»`}
      className="max-w-[480px]"
    >
      <div className="space-y-4 pt-2">
        <div className="grid grid-cols-2 gap-3">
          <Select
            label="Срок действия"
            value={ttl}
            onChange={(e) => setTtl(e.target.value as typeof ttl)}
          >
            <option value="24h">24 часа</option>
            <option value="7d">7 дней</option>
            <option value="30d">30 дней</option>
            <option value="never">Бессрочно</option>
          </Select>

          <Select
            label="Доступ"
            value={access}
            onChange={(e) => setAccess(e.target.value as typeof access)}
          >
            <option value="auth">Только вошедшим</option>
            <option value="public">По ссылке всем</option>
          </Select>
        </div>

        {shareUrl ? (
          <div className="space-y-2">
            <label className="text-xs font-medium text-[var(--text-muted)]">
              Готовая ссылка для шеринга
            </label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                readOnly
                value={shareUrl}
                className="w-full h-10 px-3 text-xs bg-[var(--surface-3)] text-[var(--text)] rounded-[var(--radius)] border border-[var(--border-control)] font-mono select-all"
              />
              <Button variant="primary" size="sm" onClick={handleCopy} className="h-10 px-3 shrink-0">
                {copied ? <Check size={14} className="mr-1" /> : <Copy size={14} className="mr-1" />}
                {copied ? 'Готово' : 'Копировать'}
              </Button>
            </div>
            <p className="text-[11px] text-[var(--text-subtle)]">
              Доступ открыт на чтение. Вы можете отозвать ссылку в любое время в настройках диалога.
            </p>
          </div>
        ) : onRequestShare ? (
          <div className="pt-2">
            <Button
              variant="primary"
              size="md"
              onClick={() => onRequestShare({ ttl, access })}
              loading={loading}
              disabled={loading}
              className="w-full gap-2"
            >
              <Share2 size={14} />
              <span>Сформировать ссылку</span>
            </Button>
          </div>
        ) : (
          <div className="pt-2">
            <SoonAction actionName="Публичный доступ к диалогам">
              <Button variant="primary" size="md" disabled className="w-full gap-2">
                <Share2 size={14} />
                <span>Сформировать ссылку (Скоро)</span>
              </Button>
            </SoonAction>
          </div>
        )}

        <div className="pt-2 border-t border-[var(--border)] text-[11px] text-[var(--text-subtle)] flex items-center gap-1.5">
          <Lock size={12} />
          <span>Криптографический токен генерируется сервером (≥ 32 байт, §16)</span>
        </div>
      </div>
    </Dialog>
  );
}
