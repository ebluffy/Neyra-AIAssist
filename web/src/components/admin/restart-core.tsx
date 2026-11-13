'use client';

import { useState } from 'react';
import { Dialog } from './dialog';

const buttonClass = 'rounded-[var(--radius)] border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-white/5 disabled:opacity-40';
const dangerClass = 'rounded-[var(--radius)] border border-red-500/50 px-3 py-1.5 text-sm text-red-300 hover:bg-red-500/10 disabled:opacity-40';

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
      <button type="button" className={dangerClass} onClick={() => setOpen(true)}>Перезапустить ядро</button>
      {message && <p role="status" className="text-xs text-emerald-300">{message}</p>}
      {error && !open && <p role="alert" className="text-xs text-red-300">{error}</p>}
      <Dialog open={open} title="Перезапустить ядро Нейры?" onClose={() => setOpen(false)}>
        <p className="text-[var(--muted)]">
          Ядро мягко остановится, systemd или docker поднимет его снова. Чат на несколько секунд станет недоступен.
          Действие попадёт в журнал.
        </p>
        {error && <p role="alert" className="mt-2 text-xs text-red-300">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className={buttonClass} onClick={() => setOpen(false)}>Отмена</button>
          <button type="button" className={dangerClass} disabled={pending} onClick={restart}>
            {pending ? 'Перезапускаю…' : 'Перезапустить'}
          </button>
        </div>
      </Dialog>
    </div>
  );
}
