'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ShieldCheck, ShieldAlert, KeyRound, Trash2, Check } from 'lucide-react';
import { Dialog } from './dialog';
import { IconButton, Button } from '../ui';

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  role: 'admin' | 'user';
  banned: boolean;
  banReason: string | null;
}

export function UserRowActions({ user, isSelf }: { user: UserRow; isSelf: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<'ban' | 'delete' | 'reset' | null>(null);
  const [reason, setReason] = useState('');
  const [resetUrl, setResetUrl] = useState('');
  const [copied, setCopied] = useState(false);

  async function callApi(url: string, init?: RequestInit) {
    setPending(true);
    setError('');
    try {
      const response = await fetch(url, init);
      const payload = await response.json().catch(() => null) as { ok?: boolean; message?: string; resetUrl?: string } | null;
      if (!response.ok || payload?.ok === false) throw new Error(payload?.message ?? 'Действие отклонено сервером.');
      return payload;
    } finally {
      setPending(false);
    }
  }

  async function changeRole(nextRole: 'admin' | 'user') {
    try {
      await callApi(`/api/admin/users/${user.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: nextRole }),
      });
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось сменить роль.');
    }
  }

  async function ban() {
    try {
      await callApi(`/api/admin/users/${user.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ banned: true, banReason: reason.trim() || undefined }),
      });
      setDialog(null);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось заблокировать.');
    }
  }

  async function unban() {
    try {
      await callApi(`/api/admin/users/${user.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ banned: false }),
      });
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось разблокировать.');
    }
  }

  async function remove() {
    try {
      await callApi(`/api/admin/users/${user.id}`, { method: 'DELETE' });
      setDialog(null);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось удалить.');
    }
  }

  async function resetPassword() {
    try {
      const result = await callApi(`/api/admin/users/${user.id}/reset-password`, { method: 'POST' });
      if (result?.resetUrl) {
        setResetUrl(result.resetUrl);
        setDialog('reset');
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось создать ссылку сброса.');
    }
  }

  async function copyLink() {
    if (!resetUrl) return;
    try {
      await navigator.clipboard.writeText(resetUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Не удалось скопировать.');
    }
  }

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <select
        value={user.role}
        disabled={pending || isSelf}
        onChange={event => changeRole(event.target.value === 'admin' ? 'admin' : 'user')}
        className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 text-xs text-[var(--text)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
      >
        <option value="user">user</option>
        <option value="admin">admin</option>
      </select>

      {user.banned ? (
        <IconButton
          type="button"
          aria-label="Разблокировать пользователя"
          tooltip="Разблокировать пользователя"
          icon={<ShieldCheck size={15} strokeWidth={1.5} />}
          variant="secondary"
          size="sm"
          disabled={pending}
          onClick={unban}
        />
      ) : (
        <IconButton
          type="button"
          aria-label="Заблокировать пользователя"
          tooltip="Заблокировать пользователя"
          icon={<ShieldAlert size={15} strokeWidth={1.5} />}
          variant="ghost"
          size="sm"
          disabled={pending || isSelf}
          onClick={() => setDialog('ban')}
          className="text-[var(--text-muted)] hover:text-[var(--text)]"
        />
      )}

      <IconButton
        type="button"
        aria-label="Сбросить пароль"
        tooltip="Сбросить пароль"
        icon={<KeyRound size={15} strokeWidth={1.5} />}
        variant="ghost"
        size="sm"
        disabled={pending}
        onClick={resetPassword}
      />

      <IconButton
        type="button"
        aria-label="Удалить пользователя"
        tooltip="Удалить пользователя"
        icon={<Trash2 size={15} strokeWidth={1.5} />}
        variant="ghost"
        size="sm"
        disabled={pending || isSelf}
        onClick={() => setDialog('delete')}
        className="text-[var(--danger)] hover:bg-[var(--danger-quiet)]"
      />

      {error && <span role="alert" className="text-xs text-[var(--danger)]">{error}</span>}

      <Dialog open={dialog === 'ban'} title={`Заблокировать ${user.email}?`} onClose={() => setDialog(null)}>
        <p className="text-[var(--text-muted)] leading-relaxed">
          Вход будет запрещён, активные сессии удалены. Причина видна в списке.
        </p>
        <label className="mt-3.5 grid gap-1.5 text-xs text-[var(--text-muted)]">
          Причина (необязательно)
          <input
            value={reason}
            maxLength={200}
            onChange={event => setReason(event.target.value)}
            className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-3)] px-3 py-2 text-sm text-[var(--text)] focus-visible:outline-none focus-visible:border-[var(--accent)]"
          />
        </label>
        <div className="mt-5 flex justify-end gap-2.5">
          <Button variant="secondary" size="sm" onClick={() => setDialog(null)}>Отмена</Button>
          <Button variant="danger" size="sm" disabled={pending} loading={pending} onClick={ban}>Заблокировать</Button>
        </div>
      </Dialog>

      <Dialog open={dialog === 'delete'} title={`Удалить ${user.email}?`} onClose={() => setDialog(null)}>
        <p className="text-[var(--text-muted)] leading-relaxed">
          Аккаунт, сессии и способы входа удалятся безвозвратно. Действие попадёт в журнал.
        </p>
        <div className="mt-5 flex justify-end gap-2.5">
          <Button variant="secondary" size="sm" onClick={() => setDialog(null)}>Отмена</Button>
          <Button variant="danger" size="sm" disabled={pending} loading={pending} onClick={remove}>Удалить</Button>
        </div>
      </Dialog>

      <Dialog open={dialog === 'reset'} title="Ссылка сброса пароля" onClose={() => { setDialog(null); setCopied(false); }}>
        <p className="text-[var(--text-muted)] leading-relaxed">
          Одноразовая ссылка действует час. Передайте её пользователю сами: сайт писем не отправляет.
        </p>
        <div className="mt-3 flex gap-2">
          <input
            readOnly
            value={resetUrl}
            aria-label="Ссылка сброса пароля"
            className="w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-3)] px-3 py-2 text-xs font-mono text-[var(--text)] focus-visible:outline-none"
          />
          <Button variant="secondary" size="sm" onClick={copyLink}>
            {copied ? <><Check size={14} className="mr-1" /> Скопировано</> : 'Копировать'}
          </Button>
        </div>
        <div className="mt-5 flex justify-end">
          <Button variant="secondary" size="sm" onClick={() => { setDialog(null); setCopied(false); }}>Закрыть</Button>
        </div>
      </Dialog>
    </div>
  );
}
