'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { LaneConfig } from '../../../lib/admin-config';

const laneLabel: Record<string, string> = {
  talk: 'Разговор',
  brain: 'Рассуждение',
  memory: 'Память',
  vision: 'Зрение',
};

interface FormState {
  provider: string;
  model: string;
  temperature: string;
  context_window: string;
  max_tokens: string;
}

function toForm(lane: LaneConfig): FormState {
  return {
    provider: lane.provider,
    model: lane.model,
    temperature: lane.temperature === null || lane.temperature === undefined ? '' : String(lane.temperature),
    context_window: lane.context_window === null || lane.context_window === undefined ? '' : String(lane.context_window),
    max_tokens: lane.max_tokens === null || lane.max_tokens === undefined ? '' : String(lane.max_tokens),
  };
}

const fieldClass = 'w-full rounded-[var(--radius)] border border-[var(--border)] bg-transparent px-2 py-1.5 text-sm';
const buttonClass = 'rounded-[var(--radius)] border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-white/5 disabled:opacity-40';

export function ModelsForm({ lanes, providers }: { lanes: Record<string, LaneConfig>; providers: string[] }) {
  const router = useRouter();
  const [forms, setForms] = useState<Record<string, FormState>>(
    () => Object.fromEntries(Object.entries(lanes).map(([lane, value]) => [lane, toForm(value)])),
  );
  const [pending, setPending] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, { tone: 'ok' | 'error' | 'warn'; text: string }>>({});

  function update(lane: string, field: keyof FormState, value: string) {
    setForms(current => ({ ...current, [lane]: { ...current[lane], [field]: value } }));
  }

  async function save(lane: string) {
    if (pending) return;
    const form = forms[lane];
    const updates: Record<string, string | number> = {
      [`llm.${lane}_model.provider`]: form.provider,
      [`llm.${lane}_model.model`]: form.model.trim(),
    };
    // talk ограничивает видимый ответ через reply_max_tokens, max_tokens там не читается.
    const maxTokensField = lane === 'talk' ? 'reply_max_tokens' : 'max_tokens';
    const numbers: Array<[string, string]> = [
      ['temperature', form.temperature],
      ['context_window', form.context_window],
      [maxTokensField, form.max_tokens],
    ];
    for (const [field, raw] of numbers) {
      if (!raw.trim()) continue;
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) {
        setMessages(current => ({ ...current, [lane]: { tone: 'error', text: `${field}: нужно число.` } }));
        return;
      }
      updates[`llm.${lane}_model.${field}`] = parsed;
    }

    setPending(lane);
    setMessages(current => ({ ...current, [lane]: { tone: 'ok', text: '' } }));
    try {
      const response = await fetch('/api/admin/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ updates }),
      });
      const payload = await response.json().catch(() => null) as
        | { ok?: boolean; data?: { requires_restart?: boolean; restart_fields?: string[] }; message?: string }
        | null;
      if (!response.ok || payload?.ok === false) {
        throw new Error(payload?.message ?? 'Ядро не приняло настройки.');
      }
      const restart = Boolean(payload?.data?.requires_restart);
      setMessages(current => ({
        ...current,
        [lane]: restart
          ? { tone: 'warn', text: 'Сохранено. Изменение применится после перезапуска ядра.' }
          : { tone: 'ok', text: 'Сохранено и применено.' },
      }));
      router.refresh();
    } catch (caught) {
      setMessages(current => ({
        ...current,
        [lane]: { tone: 'error', text: caught instanceof Error ? caught.message : 'Не удалось сохранить.' },
      }));
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-4">
      {Object.keys(lanes).map(lane => {
        const form = forms[lane];
        const message = messages[lane];
        return (
          <section key={lane} className="rounded-[var(--radius)] border border-[var(--border)] p-3">
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <h3 className="text-sm font-medium">{laneLabel[lane] ?? lane} <span className="text-xs text-[var(--muted)]">{lane}</span></h3>
              <span className="text-xs text-[var(--muted)]">сейчас: {lanes[lane].resolved_model || '—'}</span>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
              <label className="grid gap-1 text-xs">
                Провайдер
                <select value={form.provider} onChange={event => update(lane, 'provider', event.target.value)} className={fieldClass}>
                  {providers.length === 0 && <option value={form.provider}>{form.provider || '—'}</option>}
                  {providers.map(name => <option key={name} value={name}>{name}</option>)}
                </select>
              </label>
              <label className="grid gap-1 text-xs lg:col-span-2">
                Модель
                <input value={form.model} onChange={event => update(lane, 'model', event.target.value)} className={`${fieldClass} font-mono`} />
              </label>
              <label className="grid gap-1 text-xs">
                Температура
                <input value={form.temperature} inputMode="decimal" onChange={event => update(lane, 'temperature', event.target.value)} className={fieldClass} placeholder="—" />
              </label>
              <label className="grid gap-1 text-xs">
                Лимит контекста
                <input value={form.context_window} inputMode="numeric" onChange={event => update(lane, 'context_window', event.target.value)} className={fieldClass} placeholder="—" />
              </label>
              <label className="grid gap-1 text-xs">
                Max tokens
                <input value={form.max_tokens} inputMode="numeric" onChange={event => update(lane, 'max_tokens', event.target.value)} className={fieldClass} placeholder="—" />
              </label>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <button type="button" className={buttonClass} disabled={pending !== null} onClick={() => save(lane)}>
                {pending === lane ? 'Сохраняю…' : 'Сохранить'}
              </button>
              {message?.text && (
                <span
                  role={message.tone === 'error' ? 'alert' : 'status'}
                  className={message.tone === 'error' ? 'text-xs text-red-300' : message.tone === 'warn' ? 'text-xs text-amber-300' : 'text-xs text-emerald-300'}
                >
                  {message.text}
                </span>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
