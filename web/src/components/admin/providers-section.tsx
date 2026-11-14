'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Check,
  Copy,
  Key,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  X,
  Server,
} from 'lucide-react';
import { Button, IconButton } from '../ui';
import {
  isValidBaseUrl,
  isValidProviderName,
  type ProviderPreset,
  type ProviderRow,
  type ProvidersPayload,
} from '../../../lib/admin-providers';
import { playButtonClickSound } from '../../lib/ui-sounds';

const LANE_LABEL: Record<string, string> = {
  talk: 'talk',
  brain: 'brain',
  memory: 'memory',
  vision: 'vision',
};

const PROBE_TONE: Record<NonNullable<ProviderRow['probe']>['state'], { label: string; className: string }> = {
  open: { label: 'без ключа, открыт', className: 'border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-muted)]' },
  auth_required: { label: 'требует ключ', className: 'border-[var(--danger)]/40 bg-[var(--danger-quiet)] text-[var(--danger)]' },
  unreachable: { label: 'не отвечает', className: 'border-[var(--border)] bg-transparent text-[var(--text-subtle)]' },
};

const KEY_TONE: Record<ProviderRow['key_source'], { label: string; className: string }> = {
  vault: { label: 'ключ в vault', className: 'border-[var(--border-strong)] bg-[var(--surface-3)] text-[var(--text)]' },
  env: { label: 'ключ из .env', className: 'border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-muted)]' },
  yaml: { label: 'ключ в yaml', className: 'border-[var(--danger)]/40 bg-[var(--danger-quiet)] text-[var(--danger)]' },
  none: { label: 'без ключа', className: 'border-[var(--border)] bg-transparent text-[var(--text-subtle)]' },
};

interface FormState {
  mode: 'create' | 'edit';
  name: string;
  base_url: string;
  kind: string;
  presetId: string | null;
  apiKey: string;
}

const EMPTY_FORM: FormState = { mode: 'create', name: '', base_url: '', kind: 'openai', presetId: null, apiKey: '' };

export function ProvidersSection() {
  const [data, setData] = useState<ProvidersPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/admin/providers', { cache: 'no-store' });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.message || 'Ядро не отдало провайдеров.');
      const next = payload?.data ?? payload;
      if (next?.supported === false) {
        setUnsupported(next.message || 'Ядро не поддерживает управление провайдерами.');
        setData({ providers: [], presets: [], lanes: [] });
        return;
      }
      setUnsupported(null);
      setData(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка загрузки провайдеров.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const providers = useMemo(() => data?.providers ?? [], [data]);
  const presets = data?.presets ?? [];

  const startCreate = (preset?: ProviderPreset) => {
    playButtonClickSound();
    setNotice(null);
    setForm({
      mode: 'create',
      name: preset && preset.id !== 'custom' ? preset.id : '',
      base_url: preset?.base_url ?? '',
      kind: preset?.kind ?? 'openai',
      presetId: preset?.id ?? null,
      apiKey: '',
    });
  };

  const startEdit = (row: ProviderRow) => {
    playButtonClickSound();
    setNotice(null);
    setForm({ mode: 'edit', name: row.name, base_url: row.base_url, kind: row.kind, presetId: null, apiKey: '' });
  };

  const submit = async () => {
    if (!form) return;
    const name = form.name.trim().toLowerCase();
    if (!isValidProviderName(name)) {
      setNotice('Имя: строчные латинские буквы, цифры, точка, дефис или подчёркивание.');
      return;
    }
    if (!isValidBaseUrl(form.base_url)) {
      setNotice('Адрес должен начинаться с http:// или https:// и без логина в строке.');
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      const saved = await fetch(`/api/admin/providers/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base_url: form.base_url.trim(), kind: form.kind }),
      });
      const savedPayload = await saved.json().catch(() => null);
      if (!saved.ok) throw new Error(savedPayload?.message || 'Ядро не приняло провайдера.');
      if (savedPayload?.supported === false) throw new Error(savedPayload.message || 'Ядро не поддерживает управление провайдерами.');

      if (form.apiKey.trim()) {
        const secret = await fetch(`/api/admin/providers/${encodeURIComponent(name)}/secret`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ api_key: form.apiKey.trim() }),
        });
        const secretPayload = await secret.json().catch(() => null);
        if (!secret.ok) throw new Error(secretPayload?.message || 'Провайдер сохранён, но ключ не принят.');
        if (secretPayload?.supported === false) throw new Error(secretPayload.message || 'Ядро не поддерживает управление провайдерами.');
      }
      setForm(null);
      setNotice(`Провайдер «${name}» сохранён${form.apiKey.trim() ? ' вместе с ключом' : ''}.`);
      await load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Не удалось сохранить провайдера.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (name: string) => {
    setSaving(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/admin/providers/${encodeURIComponent(name)}`, { method: 'DELETE' });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.message || 'Ядро не удалило провайдера.');
      if (payload?.supported === false) throw new Error(payload.message || 'Ядро не поддерживает управление провайдерами.');
      setConfirmDelete(null);
      setNotice(`Провайдер «${name}» удалён вместе с ключом.`);
      await load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Не удалось удалить провайдера.');
    } finally {
      setSaving(false);
    }
  };

  const migrateKey = async (name: string) => {
    setSaving(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/admin/providers/${encodeURIComponent(name)}`, { method: 'POST' });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.message || 'Ядро не перенесло ключ.');
      if (payload?.supported === false) throw new Error(payload.message || 'Ядро не поддерживает управление провайдерами.');
      setNotice(`Ключ провайдера «${name}» перенесён в шифрованное хранилище.`);
      await load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Не удалось перенести ключ.');
    } finally {
      setSaving(false);
    }
  };

  const removeKey = async (name: string) => {
    setSaving(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/admin/providers/${encodeURIComponent(name)}/secret`, { method: 'DELETE' });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.message || 'Ядро не убрало ключ.');
      if (payload?.supported === false) throw new Error(payload.message || 'Ядро не поддерживает управление провайдерами.');
      setNotice(`Ключ провайдера «${name}» удалён.`);
      await load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Не удалось удалить ключ.');
    } finally {
      setSaving(false);
    }
  };

  const copyBaseUrl = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(value);
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      setNotice('Браузер не дал скопировать адрес.');
    }
  };

  if (loading && !data) {
    return (
      <div className="flex items-center gap-2 py-16 justify-center text-xs text-[var(--text-muted)]">
        <Loader2 size={16} className="animate-spin" />
        Загрузка провайдеров…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-[var(--text)]">Провайдеры</h3>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            Любой OpenAI-совместимый шлюз: свой адрес, свой ключ, сколько нужно. Ключи лежат в шифрованном хранилище ядра.
          </p>
        </div>
        <div className="flex items-center gap-2 ml-auto shrink-0">
          <IconButton
            aria-label="Обновить список провайдеров"
            tooltip="Обновить"
            icon={<RefreshCw size={14} className={loading ? 'animate-spin' : ''} />}
            variant="ghost"
            size="sm"
            onClick={() => void load()}
          />
          <Button variant="primary" size="sm" className="gap-1.5" onClick={() => startCreate()} disabled={Boolean(unsupported)}>
            <Plus size={14} />
            Добавить провайдера
          </Button>
        </div>
      </div>

      {unsupported && (
        <div role="status" className="flex items-center gap-2 p-3 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--surface-3)] text-xs text-[var(--text)]">
          <AlertCircle size={14} />
          <span>{unsupported}</span>
          <Button variant="secondary" size="sm" className="ml-auto" onClick={() => void load()}>
            Проверить снова
          </Button>
        </div>
      )}

      {error && (
        <div role="alert" className="flex items-center gap-2 p-3 rounded-[var(--radius-sm)] border border-[var(--danger)]/40 bg-[var(--danger-quiet)] text-xs text-[var(--danger)]">
          <AlertCircle size={14} />
          <span>{error}</span>
          <Button variant="secondary" size="sm" className="ml-auto" onClick={() => void load()}>
            Повторить
          </Button>
        </div>
      )}

      {notice && (
        <div role="status" className="flex items-center gap-2 p-3 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--surface-3)] text-xs text-[var(--text)]">
          <Check size={14} />
          <span>{notice}</span>
          <IconButton
            aria-label="Скрыть сообщение"
            icon={<X size={12} />}
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => setNotice(null)}
          />
        </div>
      )}

      {form && (
        <div className="rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--surface)] p-4 space-y-3.5">
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-semibold text-[var(--text)]">
              {form.mode === 'create' ? 'Новый провайдер' : `Настройка «${form.name}»`}
            </div>
            <IconButton
              aria-label="Закрыть форму"
              icon={<X size={14} />}
              variant="ghost"
              size="sm"
              onClick={() => setForm(null)}
            />
          </div>

          {form.mode === 'create' && (
            <div className="space-y-1.5">
              <div className="text-[11px] font-medium text-[var(--text-muted)]">Готовые шлюзы</div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                {presets.map((preset) => {
                  const selected = form.presetId === preset.id;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() =>
                        setForm((current) =>
                          current
                            ? {
                                ...current,
                                presetId: preset.id,
                                kind: preset.kind,
                                base_url: preset.base_url || current.base_url,
                                name:
                                  preset.id === 'custom' || current.name
                                    ? current.name
                                    : preset.id,
                              }
                            : current,
                        )
                      }
                      className={`text-left px-2.5 py-2 rounded-[var(--radius-sm)] border text-[11px] transition-colors ${
                        selected
                          ? 'border-[var(--accent)] bg-[var(--surface-3)] text-[var(--text)]'
                          : 'border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-muted)] hover:border-[var(--border-strong)] hover:text-[var(--text)]'
                      }`}
                      aria-pressed={selected}
                    >
                      <span className="block font-medium">{preset.label}</span>
                      <span className="block text-[10px] text-[var(--text-subtle)] truncate">
                        {preset.base_url || 'свой адрес'}
                      </span>
                    </button>
                  );
                })}
              </div>
              {form.presetId && (
                <p className="text-[11px] text-[var(--text-subtle)]">
                  {presets.find((preset) => preset.id === form.presetId)?.hint}
                </p>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="space-y-1 text-[11px] text-[var(--text-muted)]">
              <span className="block font-medium">Имя (латиницей)</span>
              <input
                value={form.name}
                onChange={(e) => setForm((current) => (current ? { ...current, name: e.target.value } : current))}
                disabled={form.mode === 'edit'}
                placeholder="my-laptop"
                className="w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-2 text-xs font-mono text-[var(--text)] outline-none focus:border-[var(--accent)] disabled:opacity-60"
              />
            </label>
            <label className="space-y-1 text-[11px] text-[var(--text-muted)]">
              <span className="block font-medium">Base URL (OpenAI-совместимый)</span>
              <input
                value={form.base_url}
                onChange={(e) => setForm((current) => (current ? { ...current, base_url: e.target.value } : current))}
                placeholder="http://192.168.1.10:1234/v1"
                className="w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-2 text-xs font-mono text-[var(--text)] outline-none focus:border-[var(--accent)]"
              />
            </label>
          </div>

          <label className="space-y-1 text-[11px] text-[var(--text-muted)] block">
            <span className="block font-medium">
              API-ключ {form.mode === 'edit' ? '(пусто — оставить прежний)' : '(можно добавить позже)'}
            </span>
            <input
              type="password"
              autoComplete="new-password"
              value={form.apiKey}
              onChange={(e) => setForm((current) => (current ? { ...current, apiKey: e.target.value } : current))}
              placeholder="sk-…"
              className="w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-2 text-xs font-mono text-[var(--text)] outline-none focus:border-[var(--accent)]"
            />
            <span className="block text-[10px] text-[var(--text-subtle)]">
              Ключ уходит в шифрованное хранилище ядра и никогда не показывается снова.
            </span>
          </label>

          <div className="flex items-center gap-2 pt-1">
            <Button variant="primary" size="sm" disabled={saving} loading={saving} onClick={() => void submit()}>
              {form.mode === 'create' ? 'Добавить' : 'Сохранить'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setForm(null)}>
              Отмена
            </Button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        {providers.length === 0 && !loading && (
          <div className="col-span-full flex flex-col items-center gap-2 py-10 text-center rounded-[var(--radius)] border border-dashed border-[var(--border)]">
            <Server size={18} className="text-[var(--text-subtle)]" />
            <p className="text-xs font-medium text-[var(--text)]">Провайдеров нет</p>
            <p className="text-[11px] text-[var(--text-muted)] max-w-[320px]">
              Добавь OpenAI, OpenRouter или свой локальный шлюз — лейны выберешь в разделе «Модели».
            </p>
            <Button variant="secondary" size="sm" className="mt-1" onClick={() => startCreate()}>
              Добавить провайдера
            </Button>
          </div>
        )}

        {providers.map((row) => {
          const tone = KEY_TONE[row.key_source];
          const busy = saving;
          return (
            <div
              key={row.name}
              className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3.5 space-y-2.5 transition-colors hover:border-[var(--border-strong)]"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-sm font-semibold text-[var(--text)]">{row.label}</span>
                    <span className="font-mono text-[10px] text-[var(--text-subtle)]">{row.name}</span>
                    {!row.builtin && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-muted)]">
                        свой
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex items-center gap-1.5 min-w-0">
                    <code className="text-[11px] text-[var(--text-muted)] truncate" title={row.base_url}>
                      {row.base_url || 'адрес не задан'}
                    </code>
                    {row.base_url && (
                      <IconButton
                        aria-label={`Скопировать адрес ${row.name}`}
                        tooltip="Скопировать"
                        icon={copied === row.base_url ? <Check size={12} /> : <Copy size={12} />}
                        variant="ghost"
                        size="sm"
                        className="w-6 h-6 shrink-0"
                        onClick={() => void copyBaseUrl(row.base_url)}
                      />
                    )}
                  </div>
                </div>
                {row.probe && row.key_source === 'none' && (
                  <span
                    className={`shrink-0 text-[10px] px-2 py-0.5 rounded-full border ${PROBE_TONE[row.probe.state].className}`}
                    title={row.probe.models != null ? `${row.probe.message}: моделей ${row.probe.models}` : row.probe.message}
                  >
                    {PROBE_TONE[row.probe.state].label}
                  </span>
                )}
                <span
                  className={`shrink-0 text-[10px] px-2 py-0.5 rounded-full border ${tone.className}`}
                  title={
                    row.key_source === 'yaml'
                      ? 'Ключ лежит открытым текстом в config/llm.yaml — перенесите его в vault через «Адрес и ключ»'
                      : row.key_source === 'env'
                        ? 'Ключ берётся из переменной окружения ядра'
                        : row.key_source === 'vault'
                          ? 'Ключ хранится в шифрованном хранилище ядра'
                          : 'Ключ не задан: провайдер не сможет отвечать'
                  }
                >
                  {tone.label}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-1">
                {row.lanes.length > 0 ? (
                  row.lanes.map((lane) => (
                    <span
                      key={lane}
                      className="text-[10px] px-1.5 py-0.5 rounded border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-muted)]"
                    >
                      {LANE_LABEL[lane] ?? lane}
                    </span>
                  ))
                ) : (
                  <span className="text-[10px] text-[var(--text-subtle)]">не занят ни одним лейном</span>
                )}
              </div>

              {confirmDelete === row.name ? (
                <div className="rounded-[var(--radius-sm)] border border-[var(--danger)]/40 bg-[var(--danger-quiet)] p-2.5 space-y-2">
                  <p className="text-[11px] text-[var(--danger)]">
                    Удалить «{row.name}» вместе с ключом?
                  </p>
                  <div className="flex items-center gap-1.5">
                    <Button variant="danger" size="sm" disabled={busy} onClick={() => void remove(row.name)}>
                      Да, удалить
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(null)}>
                      Отмена
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                  <Button variant="secondary" size="sm" className="gap-1.5" onClick={() => startEdit(row)}>
                    <Pencil size={12} />
                    Адрес и ключ
                  </Button>
                  {row.key_source === 'yaml' && (
                    <Button
                      variant="secondary"
                      size="sm"
                      className="gap-1.5"
                      disabled={busy}
                      onClick={() => void migrateKey(row.name)}
                    >
                      <Key size={12} />
                      Перенести ключ в vault
                    </Button>
                  )}
                  {row.key_source === 'vault' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="gap-1.5 text-[var(--danger)] hover:bg-[var(--danger-quiet)]"
                      disabled={busy}
                      onClick={() => void removeKey(row.name)}
                    >
                      <Key size={12} />
                      Убрать ключ
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="gap-1.5 ml-auto text-[var(--text-muted)] hover:text-[var(--danger)]"
                    disabled={busy || row.lanes.length > 0}
                    title={row.lanes.length > 0 ? 'Сначала переключите лейны на другого провайдера' : undefined}
                    onClick={() => setConfirmDelete(row.name)}
                  >
                    <Trash2 size={12} />
                    Удалить
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <p className="text-[11px] text-[var(--text-subtle)]">
        Ключи работают и из .env, но приоритет у vault. Модели по лейнам — в разделе «Модели».
      </p>
    </div>
  );
}
