'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Copy } from 'lucide-react';
import { Button } from '../ui';

const ttlOptions = [
  { value: '86400', label: '1 день' },
  { value: '259200', label: '3 дня' },
  { value: '604800', label: '7 дней' },
  { value: '2592000', label: '30 дней' },
];

export function InviteCreate() {
  const router = useRouter();
  const [ttl, setTtl] = useState('604800');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [link, setLink] = useState('');
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function create() {
    setPending(true);
    setError('');
    setLink('');
    try {
      const response = await fetch('/api/admin/invites', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ttlSeconds: Number(ttl) }),
      });
      const payload = await response.json().catch(() => null) as {
        ok?: boolean;
        message?: string;
        link?: string;
        invite?: { expiresAt?: string };
      } | null;
      if (!response.ok || !payload?.link) {
        throw new Error(payload?.message ?? 'Не удалось создать приглашение.');
      }
      setLink(payload.link);
      setExpiresAt(payload.invite?.expiresAt ?? null);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось создать приглашение.');
    } finally {
      setPending(false);
    }
  }

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Не удалось скопировать.');
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1.5 text-xs text-[var(--text-muted)]">
          Срок действия
          <select
            value={ttl}
            onChange={event => setTtl(event.target.value)}
            className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--text)] focus-visible:outline-none focus-visible:border-[var(--accent)]"
          >
            {ttlOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <Button variant="primary" size="md" disabled={pending} loading={pending} onClick={create}>
          Создать приглашение
        </Button>
      </div>
      {error && <p role="alert" className="text-xs text-[var(--danger)]">{error}</p>}
      {link && (
        <div className="rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--surface-2)] p-3.5 space-y-2">
          <p className="text-xs text-[var(--text)] leading-relaxed">
            Ссылка создана. Она показывается один раз — скопируйте и передайте приглашённому.
            {expiresAt && <> Действует до {new Date(expiresAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК.</>}
          </p>
          <div className="mt-2 flex gap-2">
            <input
              readOnly
              value={link}
              aria-label="Ссылка приглашения"
              className="w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-3)] px-3 py-2 text-xs font-mono text-[var(--text)] focus-visible:outline-none"
            />
            <Button variant="secondary" size="sm" onClick={copy}>
              {copied ? <><Check size={14} className="mr-1" /> Скопировано</> : <><Copy size={14} className="mr-1" /> Копировать</>}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
