'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

const ttlOptions = [
  { value: '1', label: '1 час' },
  { value: '24', label: '24 часа' },
  { value: '72', label: '3 суток' },
  { value: '168', label: '7 суток' },
  { value: '720', label: '30 суток' },
];

const buttonClass = 'rounded-[var(--radius)] border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-white/5 disabled:opacity-40';

export function InviteCreate() {
  const router = useRouter();
  const [ttl, setTtl] = useState('24');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [link, setLink] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [copied, setCopied] = useState(false);

  async function create() {
    if (pending) return;
    setPending(true);
    setError('');
    setLink('');
    setCopied(false);
    try {
      const response = await fetch('/api/admin/invites', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ttlHours: Number(ttl) }),
      });
      const payload = await response.json().catch(() => null) as { ok?: boolean; data?: { url?: string; expiresAt?: string }; message?: string } | null;
      if (!response.ok || payload?.ok === false || !payload?.data?.url) {
        throw new Error(payload?.message ?? 'Не удалось создать приглашение.');
      }
      setLink(payload.data.url);
      setExpiresAt(payload.data.expiresAt ?? '');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось создать приглашение.');
    } finally {
      setPending(false);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false);
      setError('Скопируйте ссылку вручную: буфер обмена недоступен.');
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-xs">
          Срок действия
          <select
            value={ttl}
            onChange={event => setTtl(event.target.value)}
            className="rounded-[var(--radius)] border border-[var(--border)] bg-transparent px-2 py-1.5 text-sm"
          >
            {ttlOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <button type="button" className={buttonClass} disabled={pending} onClick={create}>
          {pending ? 'Создаю…' : 'Создать приглашение'}
        </button>
      </div>
      {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
      {link && (
        <div className="rounded-[var(--radius)] border border-emerald-500/40 bg-emerald-500/10 p-3">
          <p className="text-xs text-emerald-200">
            Ссылка создана. Она показывается один раз — скопируйте и передайте приглашённому.
            {expiresAt && <> Действует до {new Date(expiresAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК.</>}
          </p>
          <div className="mt-2 flex gap-2">
            <input readOnly value={link} aria-label="Ссылка приглашения" className="w-full rounded-[var(--radius)] border border-[var(--border)] bg-transparent px-2 py-1.5 text-xs" />
            <button type="button" className={buttonClass} onClick={copy}>{copied ? 'Скопировано' : 'Копировать'}</button>
          </div>
        </div>
      )}
    </div>
  );
}
