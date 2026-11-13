'use client';

import { useState } from 'react';
import { RotateCw } from 'lucide-react';
import { Dialog } from './dialog';
import { Button } from '../ui';

export function RestartCore() {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  async function restart() {
    if (pending) return;
    setPending(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch('/api/admin/system/restart', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target: 'core' }),
      });
      const payload = await response.json().catch(() => null) as { ok?: boolean; data?: { note?: string }; message?: string } | null;
      if (!response.ok || payload?.ok === false) throw new Error(payload?.message ?? 'Ядро не перезапустилось.');
      setOpen(false);
      setMessage(payload?.data?.note ?? 'Команда перезапуска принята ядром.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Ядро не перезапустилось.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-2">
      <Button variant="danger" size="md" onClick={() => setOpen(true)}>
        <RotateCw size={14} className="mr-1.5" />
        <span>Перезапустить ядро</span>
      </Button>
      {message && <p role="status" className="text-xs text-[var(--text)] bg-[var(--surface-3)] p-2 rounded-[var(--radius-sm)] border border-[var(--border)]">{message}</p>}
      {error && !open && <p role="alert" className="text-xs text-[var(--danger)]">{error}</p>}
      <Dialog open={open} title="Перезапустить ядро Нейры?" onClose={() => setOpen(false)}>
        <p className="text-[var(--text-muted)] leading-relaxed">
          Ядро мягко остановится, systemd или docker поднимет его снова. Чат на несколько секунд станет недоступен.
          Действие попадёт в журнал.
        </p>
        {error && <p role="alert" className="mt-2 text-xs text-[var(--danger)]">{error}</p>}
        <div className="mt-5 flex justify-end gap-2.5">
          <Button variant="secondary" size="sm" onClick={() => setOpen(false)}>
            Отмена
          </Button>
          <Button variant="danger" size="sm" disabled={pending} loading={pending} onClick={restart}>
            {pending ? 'Перезапускаю…' : 'Перезапустить'}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
