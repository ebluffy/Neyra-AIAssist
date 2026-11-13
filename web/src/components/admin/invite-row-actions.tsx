'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Ban } from 'lucide-react';
import { Dialog } from './dialog';
import { IconButton, Button } from '../ui';

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
    <div className="flex items-center gap-1.5">
      <IconButton
        type="button"
        aria-label="Отозвать приглашение"
        tooltip="Отозвать приглашение"
        icon={<Ban size={15} strokeWidth={1.5} />}
        variant="ghost"
        size="sm"
        disabled={disabled || pending}
        onClick={() => setOpen(true)}
        className="text-[var(--danger)] hover:bg-[var(--danger-quiet)]"
      />
      {error && !open && <span role="alert" className="text-xs text-[var(--danger)]">{error}</span>}
      <Dialog open={open} title="Отозвать приглашение?" onClose={() => setOpen(false)}>
        <p className="text-[var(--text-muted)] leading-relaxed">
          Ссылка перестанет работать. Уже зарегистрированного пользователя это не затронет.
        </p>
        {error && <p role="alert" className="mt-2 text-xs text-[var(--danger)]">{error}</p>}
        <div className="mt-5 flex justify-end gap-2.5">
          <Button variant="secondary" size="sm" onClick={() => setOpen(false)}>
            Отмена
          </Button>
          <Button variant="danger" size="sm" disabled={pending} loading={pending} onClick={revoke}>
            Отозвать
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
