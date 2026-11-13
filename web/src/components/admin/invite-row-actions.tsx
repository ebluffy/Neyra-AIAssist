'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Dialog } from './dialog';

const buttonClass = 'rounded-[var(--radius)] border border-[var(--border)] px-2.5 py-1 text-xs hover:bg-white/5 disabled:opacity-40';
const dangerClass = 'rounded-[var(--radius)] border border-red-500/50 px-2.5 py-1 text-xs text-red-300 hover:bg-red-500/10 disabled:opacity-40';

export function InviteRowActions({ id, disabled }: { id: string; disabled: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  async function revoke() {
    if (pending) return;
    setPending(true);
    setError('');
    try {
      const response = await fetch(`/api/admin/invites/${id}`, { method: 'DELETE' });
      const payload = await response.json().catch(() => null) as { ok?: boolean; message?: string } | null;
      if (!response.ok || payload?.ok === false) throw new Error(payload?.message ?? 'Не удалось отозвать приглашение.');
      setOpen(false);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось отозвать приглашение.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button type="button" className={dangerClass} disabled={disabled || pending} onClick={() => setOpen(true)}>
        Отозвать
      </button>
      {error && !open && <span role="alert" className="text-xs text-red-300">{error}</span>}
      <Dialog open={open} title="Отозвать приглашение?" onClose={() => setOpen(false)}>
        <p className="text-[var(--muted)]">Ссылка перестанет работать. Уже зарегистрированного пользователя это не затронет.</p>
        {error && <p role="alert" className="mt-2 text-xs text-red-300">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className={buttonClass} onClick={() => setOpen(false)}>Отмена</button>
          <button type="button" className={dangerClass} disabled={pending} onClick={revoke}>Отозвать</button>
        </div>
      </Dialog>
    </div>
  );
}
