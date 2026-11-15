'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Dialog } from './dialog';

export interface AdminUserView {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'user';
  banned: boolean;
  banReason: string | null;
}

interface Props {
  user: AdminUserView;
  isSelf: boolean;
}

type DialogKind = 'ban' | 'delete' | 'reset' | null;

async function callApi(path: string, init: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const payload = await response.json().catch(() => null) as { ok?: boolean; data?: Record<string, unknown>; message?: string } | null;
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.message ?? 'Не удалось выполнить действие.');
  }
  return payload?.data ?? {};
}

const buttonClass = 'rounded-[var(--radius)] border border-[var(--border)] px-2.5 py-1 text-xs hover:bg-white/5 disabled:opacity-40';
const dangerClass = 'rounded-[var(--radius)] border border-red-500/50 px-2.5 py-1 text-xs text-red-300 hover:bg-red-500/10 disabled:opacity-40';

export function UserRowActions({ user, isSelf }: Props) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [reason, setReason] = useState('');
  const [resetUrl, setResetUrl] = useState('');
  const [copied, setCopied] = useState(false);

  async function run(action: () => Promise<void>) {
    if (pending) return;
    setPending(true);
    setError('');
    try {
      await action();
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось выполнить действие.');
    } finally {
      setPending(false);
    }
  }

  async function changeRole(nextRole: 'admin' | 'user') {
    await run(async () => {
      await callApi(`/api/admin/users/${user.id}`, { method: 'PATCH', body: JSON.stringify({ role: nextRole }) });
    });
  }

  async function ban() {
    await run(async () => {
      await callApi(`/api/admin/users/${user.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ banned: true, banReason: reason }),
      });
      setDialog(null);
      setReason('');
    });
  }

  async function unban() {
    await run(async () => {
      await callApi(`/api/admin/users/${user.id}`, { method: 'PATCH', body: JSON.stringify({ banned: false }) });
    });
  }

  async function remove() {
    await run(async () => {
      await callApi(`/api/admin/users/${user.id}`, { method: 'DELETE' });
      setDialog(null);
    });
  }

  async function resetPassword() {
    await run(async () => {
      const data = await callApi(`/api/admin/users/${user.id}/reset-password`, { method: 'POST' });
      setResetUrl(typeof data.url === 'string' ? data.url : '');
      setDialog('reset');
    });
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(resetUrl);
      setCopied(true);
    } catch {
      setCopied(false);
      setError('Скопируйте ссылку вручную: буфер обмена недоступен.');
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="sr-only" htmlFor={`role-${user.id}`}>Роль {user.email}</label>
      <select
        id={`role-${user.id}`}
        value={user.role}
        disabled={pending || isSelf}
        onChange={event => changeRole(event.target.value === 'admin' ? 'admin' : 'user')}
        className="rounded-[var(--radius)] border border-[var(--border)] bg-transparent px-2 py-1 text-xs"
      >
        <option value="user">user</option>
        <option value="admin">admin</option>
      </select>
      {user.banned ? (
        <button type="button" className={buttonClass} disabled={pending} onClick={unban}>Разблокировать</button>
      ) : (
        <button type="button" className={buttonClass} disabled={pending || isSelf} onClick={() => setDialog('ban')}>Заблокировать</button>
      )}
      <button type="button" className={buttonClass} disabled={pending} onClick={resetPassword}>Сброс пароля</button>
      <button type="button" className={dangerClass} disabled={pending || isSelf} onClick={() => setDialog('delete')}>Удалить</button>
      {error && <span role="alert" className="text-xs text-red-300">{error}</span>}

      <Dialog open={dialog === 'ban'} title={`Заблокировать ${user.email}?`} onClose={() => setDialog(null)}>
        <p className="text-[var(--muted)]">Вход будет запрещён, активные сессии удалены. Причина видна в списке.</p>
        <label className="mt-3 grid gap-1 text-xs">
          Причина (необязательно)
          <input
            value={reason}
            maxLength={200}
            onChange={event => setReason(event.target.value)}
            className="rounded-[var(--radius)] border border-[var(--border)] bg-transparent px-2 py-1.5 text-sm"
          />
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className={buttonClass} onClick={() => setDialog(null)}>Отмена</button>
          <button type="button" className={dangerClass} disabled={pending} onClick={ban}>Заблокировать</button>
        </div>
      </Dialog>

      <Dialog open={dialog === 'delete'} title={`Удалить ${user.email}?`} onClose={() => setDialog(null)}>
        <p className="text-[var(--muted)]">Аккаунт, сессии и способы входа удалятся безвозвратно. Действие попадёт в журнал.</p>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className={buttonClass} onClick={() => setDialog(null)}>Отмена</button>
          <button type="button" className={dangerClass} disabled={pending} onClick={remove}>Удалить</button>
        </div>
      </Dialog>

      <Dialog open={dialog === 'reset'} title="Ссылка сброса пароля" onClose={() => { setDialog(null); setCopied(false); }}>
        <p className="text-[var(--muted)]">Одноразовая ссылка действует час. Передайте её пользователю сами: сайт писем не отправляет.</p>
        <div className="mt-3 flex gap-2">
          <input readOnly value={resetUrl} aria-label="Ссылка сброса пароля" className="w-full rounded-[var(--radius)] border border-[var(--border)] bg-transparent px-2 py-1.5 text-xs" />
          <button type="button" className={buttonClass} onClick={copyLink}>{copied ? 'Скопировано' : 'Копировать'}</button>
        </div>
        <div className="mt-4 flex justify-end">
          <button type="button" className={buttonClass} onClick={() => { setDialog(null); setCopied(false); }}>Закрыть</button>
        </div>
      </Dialog>
    </div>
  );
}
