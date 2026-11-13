'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export interface MemoryFormProps {
  limits: Record<string, number>;
  autocompact: { enabled: boolean; mode: string; threshold_messages: number };
}

const fields: Array<{ path: string; label: string; hint: string }> = [
  { path: 'memory.stm_max_messages', label: 'Окно короткой памяти', hint: 'сообщений в RAM' },
  { path: 'memory.max_records', label: 'Максимум записей LTM', hint: 'целевой размер долгой памяти' },
  { path: 'memory.rag_top_k', label: 'Фрагментов в ответе RAG', hint: 'сколько кусков памяти подмешивать' },
  { path: 'memory.diary_max_entries', label: 'Записей дневника', hint: 'жёсткий лимит' },
];

const fieldClass = 'w-full rounded-[var(--radius)] border border-[var(--border)] bg-transparent px-2 py-1.5 text-sm';
const buttonClass = 'rounded-[var(--radius)] border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-white/5 disabled:opacity-40';

export function MemoryLimitsForm({ limits, autocompact }: MemoryFormProps) {
  const router = useRouter();
  const [values, setValues] = useState<Record<string, string>>(
    () => Object.fromEntries(fields.map(field => [field.path, String(limits[field.path] ?? '')])),
  );
  const [enabled, setEnabled] = useState(autocompact.enabled);
  const [threshold, setThreshold] = useState(String(autocompact.threshold_messages));
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error' | 'warn'; text: string } | null>(null);

  async function save() {
    if (pending) return;
    const updates: Record<string, number | boolean> = {};
    for (const field of fields) {
      const raw = values[field.path];
      const parsed = Number(raw);
      if (!raw.trim() || !Number.isFinite(parsed)) {
        setMessage({ tone: 'error', text: `${field.label}: нужно число.` });
        return;
      }
      updates[field.path] = parsed;
    }
    const thresholdValue = Number(threshold);
    if (!Number.isFinite(thresholdValue)) {
      setMessage({ tone: 'error', text: 'Порог автосжатия: нужно число.' });
      return;
    }
    updates['memory.session_archive.enabled'] = enabled;
    updates['memory.session_archive.threshold_messages'] = thresholdValue;

    setPending(true);
    setMessage(null);
    try {
      const response = await fetch('/api/admin/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ updates }),
      });
      const payload = await response.json().catch(() => null) as
        | { ok?: boolean; data?: { requires_restart?: boolean }; message?: string }
        | null;
      if (!response.ok || payload?.ok === false) {
        throw new Error(payload?.message ?? 'Ядро не приняло настройки.');
      }
      setMessage(
        payload?.data?.requires_restart
          ? { tone: 'warn', text: 'Сохранено. Лимиты памяти применятся после перезапуска ядра.' }
          : { tone: 'ok', text: 'Сохранено.' },
      );
      router.refresh();
    } catch (caught) {
      setMessage({ tone: 'error', text: caught instanceof Error ? caught.message : 'Не удалось сохранить.' });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2">
        {fields.map(field => (
          <label key={field.path} className="grid gap-1 text-xs">
            {field.label}
            <input
              value={values[field.path]}
              inputMode="numeric"
              onChange={event => setValues(current => ({ ...current, [field.path]: event.target.value }))}
              className={fieldClass}
            />
            <span className="text-[var(--muted)]">{field.hint}</span>
          </label>
        ))}
      </div>

      <fieldset className="rounded-[var(--radius)] border border-[var(--border)] p-3">
        <legend className="px-1 text-xs text-[var(--muted)]">Автосжатие сессий</legend>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />
          Включено
        </label>
        <label className="mt-2 grid max-w-xs gap-1 text-xs">
          Порог, сообщений (0 — выключено)
          <input value={threshold} inputMode="numeric" onChange={event => setThreshold(event.target.value)} className={fieldClass} />
        </label>
        <p className="mt-2 text-xs text-[var(--muted)]">Сейчас режим: {autocompact.mode}.</p>
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={buttonClass} disabled={pending} onClick={save}>
          {pending ? 'Сохраняю…' : 'Сохранить лимиты'}
        </button>
        {message?.text && (
          <span
            role={message.tone === 'error' ? 'alert' : 'status'}
            className={message.tone === 'error' ? 'text-xs text-[var(--danger)]' : message.tone === 'warn' ? 'text-xs text-[var(--text-muted)]' : 'text-xs text-[var(--text)]'}
          >
            {message.text}
          </span>
        )}
      </div>
    </div>
  );
}
