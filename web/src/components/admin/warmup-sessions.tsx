'use client';

import { useState } from 'react';

const buttonClass = 'rounded-[var(--radius)] border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-white/5 disabled:opacity-40';

export function WarmupSessions() {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  async function warmup() {
    if (pending) return;
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch('/api/admin/system/warmup', { method: 'POST' });
      const payload = await response.json().catch(() => null) as
        | { ok?: boolean; data?: { accepted?: boolean }; message?: string }
        | null;
      if (!response.ok || payload?.ok === false) {
        throw new Error(payload?.message ?? 'Ядро не приняло прогрев.');
      }
      setMessage({
        tone: 'ok',
        text: payload?.data?.accepted ? 'Прогрев запущен.' : 'Ядро ответило: прогрев не требуется.',
      });
    } catch (caught) {
      setMessage({ tone: 'error', text: caught instanceof Error ? caught.message : 'Не удалось запустить прогрев.' });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-2">
      <button type="button" className={buttonClass} disabled={pending} onClick={warmup}>
        {pending ? 'Запускаю…' : 'Прогреть сессии'}
      </button>
      {message?.text && (
        <p role={message.tone === 'error' ? 'alert' : 'status'} className={message.tone === 'error' ? 'text-xs text-[var(--danger)]' : 'text-xs text-[var(--text)]'}>
          {message.text}
        </p>
      )}
    </div>
  );
}
