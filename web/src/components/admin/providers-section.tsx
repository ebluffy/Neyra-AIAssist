'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Brain,
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  Eye,
  Key,
  Loader2,
  Mic,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Settings2,
  Trash2,
  Volume2,
  X,
} from 'lucide-react';
import { Button, IconButton } from '../ui';
import {
  isValidBaseUrl,
  isValidProviderName,
  PROVIDER_TYPES,
  type ProviderField,
  type ProviderFieldValue,
  type ProviderPreset,
  type ProviderRow,
  type ProviderType,
  type ProvidersPayload,
} from '../../../lib/admin-providers';
import { playButtonClickSound } from '../../lib/ui-sounds';

const TYPE_ORDER: ProviderType[] = ['llm', 'vision', 'stt', 'tts'];

const TYPE_META: Record<ProviderType, { label: string; icon: typeof Brain }> = {
  llm: { label: 'LLM', icon: Brain },
  vision: { label: 'Vision', icon: Eye },
  stt: { label: 'Речь → текст', icon: Mic },
  tts: { label: 'Текст → речь', icon: Volume2 },
};

const LANE_LABEL: Record<string, string> = {
  talk: 'talk',
  brain: 'brain',
  memory: 'memory',
  vision: 'vision',
};

const PROBE_TONE: Record<NonNullable<ProviderRow['probe']>['state'], { label: string; className: string }> = {
  open: { label: 'отвечает', className: 'border-[var(--border)] bg-[var(--surface-3)] text-[var(--text)]' },
  auth_required: { label: 'нужен ключ', className: 'border-[var(--danger)]/40 bg-[var(--danger-quiet)] text-[var(--danger)]' },
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
  presetId: string;
  name: string;
  base_url: string;
  kind: string;
  provider_type: ProviderType;
  fields: Record<string, string>;
  apiKey: string;
  needsKey: boolean;
  advanced: boolean;
}

function TypeBadge({ type, label }: { type: ProviderType; label?: string }) {
  const meta = TYPE_META[type] ?? TYPE_META.llm;
  const Icon = meta.icon;
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-2 py-0.5 text-[10px] font-medium text-[var(--text-muted)]">
      <Icon size={10} />
      {label ?? meta.label}
    </span>
  );
}

function initialFields(preset: ProviderPreset | null, stored?: Record<string, ProviderFieldValue>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of preset?.fields ?? []) {
    const value = stored?.[field.key];
    out[field.key] = value == null ? String(field.default ?? '') : String(value);
  }
  return out;
}

function fieldsSummary(row: ProviderRow, preset: ProviderPreset | null): string[] {
  if (!preset) return [];
  const stored = row.fields ?? {};
  return preset.fields
    .filter((field) => stored[field.key] !== undefined && stored[field.key] !== '')
    .slice(0, 3)
    .map((field) => `${field.label}: ${String(stored[field.key])}`);
}

function providerStatus(row: ProviderRow): { label: string; className: string; title: string } {
  if (row.needs_key && !row.has_key) {
    return {
      label: 'нужен ключ',
      className: 'border-[var(--danger)]/40 bg-[var(--danger-quiet)] text-[var(--danger)]',
      title: 'Без ключа провайдер не сможет отвечать',
    };
  }
  if ((row.provider_type === 'stt' || row.provider_type === 'tts') && !row.probe) {
    return {
      label: 'ключ сохранён',
      className: 'border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-muted)]',
      title: 'Проверка ключа произойдёт при первом голосовом запросе',
    };
  }
  if (row.probe) {
    return { ...PROBE_TONE[row.probe.state], title: row.probe.message };
  }
  return {
    label: 'не проверено',
    className: 'border-[var(--border)] bg-transparent text-[var(--text-subtle)]',
    title: 'Ядро ещё не проверяло этот адрес',
  };
}

export function ProvidersSection() {
  const [data, setData] = useState<ProvidersPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | ProviderType>('all');
  const [showAdvanced, setShowAdvanced] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/admin/providers', { cache: 'no-store' });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.message || 'Ядро не отдало провайдеров.');
      setData(payload?.data ?? payload);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка загрузки провайдеров.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const providers = data?.providers ?? [];
  const presets = data?.presets ?? [];
  const presetById = useMemo(() => new Map(presets.map((preset) => [preset.id, preset])), [presets]);

  const connectedPresetIds = useMemo(
    () => new Set(providers.map((row) => row.preset || row.name)),
    [providers],
  );

  const available = useMemo(
    () => presets.filter((preset) => preset.id !== 'custom' && !connectedPresetIds.has(preset.id)),
    [connectedPresetIds, presets],
  );

  const customPreset = presets.find((preset) => preset.id === 'custom') ?? null;
  const activePreset = form ? presetById.get(form.presetId) ?? null : null;
  const activeFields = activePreset?.fields ?? [];

  const matches = useCallback(
    (type: ProviderType) => filter === 'all' || filter === type,
    [filter],
  );

  const visibleProviders = providers.filter((row) => matches(row.provider_type));
  const visibleAvailable = available.filter((preset) => matches(preset.type));

  const startCreate = (preset: ProviderPreset) => {
    playButtonClickSound();
    setNotice(null);
    setConfirmDelete(null);
    setShowAdvanced(preset.id === 'custom' || !preset.base_url);
    setForm({
      mode: 'create',
      presetId: preset.id,
      name: preset.id === 'custom' ? '' : preset.id,
      base_url: preset.base_url,
      kind: preset.kind,
      provider_type: preset.type,
      fields: initialFields(preset),
      apiKey: '',
      needsKey: preset.needs_key,
      advanced: preset.id === 'custom' || !preset.base_url,
    });
  };

  const startEdit = (row: ProviderRow) => {
    playButtonClickSound();
    setNotice(null);
    setConfirmDelete(null);
    const presetId = row.preset || (presetById.has(row.name) ? row.name : '');
    const preset = presetById.get(presetId) ?? null;
    setShowAdvanced(!preset || !preset.base_url);
    setForm({
      mode: 'edit',
      presetId,
      name: row.name,
      base_url: row.base_url,
      kind: row.kind,
      provider_type: row.provider_type,
      fields: initialFields(preset, row.fields),
      apiKey: '',
      needsKey: row.needs_key,
      advanced: !preset || !preset.base_url,
    });
  };

  const closeForm = () => {
    setForm(null);
    setNotice(null);
    setShowAdvanced(false);
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
    if (form.mode === 'create' && form.needsKey && !form.apiKey.trim()) {
      setNotice('Вставьте API-ключ: для этого провайдера он обязателен.');
      return;
    }

    const fieldsPayload: Record<string, ProviderFieldValue> = {};
    for (const field of activeFields) {
      const raw = (form.fields[field.key] ?? '').trim();
      if (field.required && !raw) {
        setNotice(`Заполните «${field.label}».`);
        return;
      }
      if (!raw) {
        fieldsPayload[field.key] = '';
        continue;
      }
      if (field.kind === 'number') {
        const value = Number(raw.replace(',', '.'));
        if (!Number.isFinite(value)) {
          setNotice(`«${field.label}»: нужно число.`);
          return;
        }
        if (typeof field.min === 'number' && value < field.min) {
          setNotice(`«${field.label}»: не меньше ${field.min}.`);
          return;
        }
        if (typeof field.max === 'number' && value > field.max) {
          setNotice(`«${field.label}»: не больше ${field.max}.`);
          return;
        }
        fieldsPayload[field.key] = value;
      } else {
        fieldsPayload[field.key] = raw;
      }
    }

    setSaving(true);
    setNotice(null);
    try {
      const saved = await fetch(`/api/admin/providers/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          base_url: form.base_url.trim(),
          kind: form.kind,
          preset: form.presetId || undefined,
          provider_type: form.provider_type,
          fields: fieldsPayload,
        }),
      });
      const savedPayload = await saved.json().catch(() => null);
      if (!saved.ok) throw new Error(savedPayload?.message || 'Ядро не приняло провайдера.');

      if (form.apiKey.trim()) {
        const secret = await fetch(`/api/admin/providers/${encodeURIComponent(name)}/secret`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ api_key: form.apiKey.trim() }),
        });
        const secretPayload = await secret.json().catch(() => null);
        if (!secret.ok) throw new Error(secretPayload?.message || 'Провайдер сохранён, но ключ не принят.');
      }
      const label = form.presetId ? presetById.get(form.presetId)?.label ?? name : name;
      setForm(null);
      setShowAdvanced(false);
      setNotice(
        form.mode === 'create'
          ? `${label} подключён${form.apiKey.trim() ? ' вместе с ключом' : ''}.`
          : `Настройки «${name}» сохранены${form.apiKey.trim() ? ' вместе с ключом' : ''}.`,
      );
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

  const updateField = (key: string, value: string) => {
    setForm((current) =>
      current ? { ...current, fields: { ...current.fields, [key]: value } } : current,
    );
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
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-[var(--text)]">Провайдеры</h3>
          <p className="text-xs text-[var(--text-muted)] mt-0.5 max-w-xl">
            Готовые карточки: вставьте ключ и при необходимости уточните пару полей. Любой
            OpenAI-совместимый шлюз: свой адрес, свой ключ, сколько нужно. Ключи лежат в шифрованном
            хранилище ядра и не показываются снова.
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
          {customPreset && (
            <Button variant="primary" size="sm" className="gap-1.5" onClick={() => startCreate(customPreset)}>
              <Plus size={14} />
              Свой провайдер
            </Button>
          )}
        </div>
      </div>

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

      <div role="tablist" aria-label="Вид провайдера" className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          role="tab"
          aria-selected={filter === 'all'}
          onClick={() => setFilter('all')}
          className={`px-2.5 py-1 rounded-full border text-[11px] transition-colors ${
            filter === 'all'
              ? 'border-[var(--accent)] bg-[var(--surface-3)] text-[var(--text)]'
              : 'border-[var(--border)] bg-transparent text-[var(--text-muted)] hover:border-[var(--border-strong)] hover:text-[var(--text)]'
          }`}
        >
          Все
        </button>
        {TYPE_ORDER.map((type) => {
          const meta = TYPE_META[type];
          const Icon = meta.icon;
          const count =
            providers.filter((row) => row.provider_type === type).length +
            available.filter((preset) => preset.type === type).length;
          return (
            <button
              key={type}
              type="button"
              role="tab"
              aria-selected={filter === type}
              onClick={() => setFilter(type)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] transition-colors ${
                filter === type
                  ? 'border-[var(--accent)] bg-[var(--surface-3)] text-[var(--text)]'
                  : 'border-[var(--border)] bg-transparent text-[var(--text-muted)] hover:border-[var(--border-strong)] hover:text-[var(--text)]'
              }`}
            >
              <Icon size={11} />
              {meta.label}
              <span className="text-[var(--text-subtle)]">{count}</span>
            </button>
          );
        })}
      </div>

      {form && (
        <div className="rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--surface)] p-4 space-y-3.5">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <div className="text-sm font-semibold text-[var(--text)]">
                  {form.mode === 'create'
                    ? activePreset
                      ? `Подключить ${activePreset.label}`
                      : 'Новый провайдер'
                    : `Настройка «${form.name}»`}
                </div>
                <TypeBadge type={form.provider_type} />
              </div>
              {activePreset?.hint && (
                <p className="text-[11px] text-[var(--text-muted)] mt-1">{activePreset.hint}</p>
              )}
            </div>
            <IconButton
              aria-label="Закрыть форму"
              icon={<X size={14} />}
              variant="ghost"
              size="sm"
              onClick={closeForm}
            />
          </div>

          {activePreset && activePreset.id !== 'custom' && (
            <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-[11px] text-[var(--text-muted)]">
              <span className="font-medium text-[var(--text)]">{activePreset.label}</span>
              <TypeBadge type={activePreset.type} />
              {!activePreset.needs_key && <span>ключ не нужен</span>}
              {activePreset.docs_url && (
                <a
                  href={activePreset.docs_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-auto inline-flex items-center gap-1 text-[var(--text-muted)] hover:text-[var(--text)]"
                >
                  Документация
                  <ExternalLink size={11} />
                </a>
              )}
            </div>
          )}

          {(form.presetId === '' || (form.mode === 'create' && form.presetId === 'custom')) && (
            <label className="space-y-1 text-[11px] text-[var(--text-muted)] block">
              <span className="block font-medium">Вид провайдера</span>
              <select
                value={form.provider_type}
                onChange={(e) =>
                  setForm((current) =>
                    current ? { ...current, provider_type: e.target.value as ProviderType } : current,
                  )
                }
                className="w-full sm:w-64 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-2 text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]"
              >
                {PROVIDER_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {TYPE_META[type].label}
                  </option>
                ))}
              </select>
            </label>
          )}

          {activeFields.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {activeFields.map((field) => (
                <ProviderFieldInput
                  key={field.key}
                  field={field}
                  value={form.fields[field.key] ?? ''}
                  onChange={(value) => updateField(field.key, value)}
                />
              ))}
            </div>
          )}

          <label className="space-y-1 text-[11px] text-[var(--text-muted)] block">
            <span className="block font-medium">
              API-ключ
              {form.needsKey ? ' *' : ' (необязательно)'}
              {form.mode === 'edit' ? ' — пусто, чтобы оставить прежний' : ''}
            </span>
            <input
              type="password"
              autoComplete="new-password"
              value={form.apiKey}
              onChange={(e) => setForm((current) => (current ? { ...current, apiKey: e.target.value } : current))}
              placeholder={form.needsKey ? 'sk-…' : 'локальный шлюз может работать без ключа'}
              className="w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-2 text-xs font-mono text-[var(--text)] outline-none focus:border-[var(--accent)]"
            />
            <span className="block text-[10px] text-[var(--text-subtle)]">
              Ключ уходит в шифрованное хранилище ядра и никогда не показывается снова.
            </span>
          </label>

          {!showAdvanced ? (
            <button
              type="button"
              onClick={() => setShowAdvanced(true)}
              className="inline-flex items-center gap-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--text)]"
            >
              <Settings2 size={12} />
              Имя и адрес
              <ChevronDown size={12} />
            </button>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] p-3">
              <label className="space-y-1 text-[11px] text-[var(--text-muted)]">
                <span className="block font-medium">Имя (латиницей)</span>
                <input
                  value={form.name}
                  onChange={(e) => setForm((current) => (current ? { ...current, name: e.target.value } : current))}
                  disabled={form.mode === 'edit'}
                  placeholder="my-laptop"
                  className="w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-2.5 py-2 text-xs font-mono text-[var(--text)] outline-none focus:border-[var(--accent)] disabled:opacity-60"
                />
              </label>
              <label className="space-y-1 text-[11px] text-[var(--text-muted)]">
                <span className="block font-medium">Base URL</span>
                <input
                  value={form.base_url}
                  onChange={(e) =>
                    setForm((current) => (current ? { ...current, base_url: e.target.value } : current))
                  }
                  placeholder="http://192.168.1.10:1234/v1"
                  className="w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-2.5 py-2 text-xs font-mono text-[var(--text)] outline-none focus:border-[var(--accent)]"
                />
              </label>
            </div>
          )}

          <div className="flex items-center gap-2 pt-1">
            <Button variant="primary" size="sm" disabled={saving} loading={saving} onClick={() => void submit()}>
              {form.mode === 'create' ? 'Подключить' : 'Сохранить'}
            </Button>
            <Button variant="ghost" size="sm" onClick={closeForm}>
              Отмена
            </Button>
          </div>
        </div>
      )}

      <section className="space-y-2.5">
        <div className="flex items-center gap-2">
          <h4 className="text-sm font-semibold text-[var(--text)]">Подключённые</h4>
          <span className="text-[11px] text-[var(--text-subtle)]">{visibleProviders.length}</span>
        </div>

        {visibleProviders.length === 0 ? (
          <div className="rounded-[var(--radius)] border border-dashed border-[var(--border)] px-4 py-6 text-center">
            <Server size={18} className="mx-auto text-[var(--text-subtle)]" />
            <p className="text-xs font-medium text-[var(--text)] mt-1.5">
              {providers.length === 0 ? 'Пока ничего не подключено' : 'В этом виде провайдеров нет'}
            </p>
            <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
              Выберите карточку ниже — понадобится только ключ.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
            {visibleProviders.map((row) => {
              const tone = KEY_TONE[row.key_source];
              const status = providerStatus(row);
              const preset = presetById.get(row.preset) ?? null;
              const summary = fieldsSummary(row, preset);
              return (
                <div
                  key={row.name}
                  className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3.5 space-y-2.5 transition-colors hover:border-[var(--border-strong)]"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-sm font-semibold text-[var(--text)]">{row.label}</span>
                        <TypeBadge type={row.provider_type} label={row.provider_type_label} />
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
                    <span className={`shrink-0 text-[10px] px-2 py-0.5 rounded-full border ${status.className}`} title={status.title}>
                      {status.label}
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
                    <span className={`text-[10px] px-2 py-0.5 rounded-full border ${tone.className}`} title={tone.label}>
                      {tone.label}
                    </span>
                  </div>

                  {summary.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {summary.map((item) => (
                        <span
                          key={item}
                          className="text-[10px] px-1.5 py-0.5 rounded border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-muted)] max-w-full truncate"
                          title={item}
                        >
                          {item}
                        </span>
                      ))}
                    </div>
                  )}

                  {confirmDelete === row.name ? (
                    <div className="rounded-[var(--radius-sm)] border border-[var(--danger)]/40 bg-[var(--danger-quiet)] p-2.5 space-y-2">
                      <p className="text-[11px] text-[var(--danger)]">Удалить «{row.name}» вместе с ключом?</p>
                      <div className="flex items-center gap-1.5">
                        <Button variant="danger" size="sm" disabled={saving} onClick={() => void remove(row.name)}>
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
                        Настроить
                      </Button>
                      {row.key_source === 'yaml' && (
                        <Button
                          variant="secondary"
                          size="sm"
                          className="gap-1.5"
                          disabled={saving}
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
                          disabled={saving}
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
                        disabled={saving || row.lanes.length > 0}
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
        )}
      </section>

      <section className="space-y-2.5">
        <div className="flex items-center gap-2">
          <h4 className="text-sm font-semibold text-[var(--text)]">Доступные</h4>
          <span className="text-[11px] text-[var(--text-subtle)]">{visibleAvailable.length}</span>
        </div>

        {visibleAvailable.length === 0 ? (
          <p className="rounded-[var(--radius)] border border-dashed border-[var(--border)] px-4 py-5 text-center text-[11px] text-[var(--text-muted)]">
            {available.length === 0
              ? 'Все провайдеры из каталога уже подключены.'
              : 'В этом виде больше нет доступных карточек.'}
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2.5">
            {visibleAvailable.map((preset) => {
              const meta = TYPE_META[preset.type];
              const Icon = meta.icon;
              return (
                <div
                  key={preset.id}
                  className="flex flex-col gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3 transition-colors hover:border-[var(--border-strong)]"
                >
                  <div className="flex items-start gap-2">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-muted)]">
                      <Icon size={15} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-xs font-semibold text-[var(--text)]">{preset.label}</span>
                        <TypeBadge type={preset.type} />
                      </div>
                      <code className="mt-0.5 block truncate text-[10px] text-[var(--text-subtle)]" title={preset.base_url}>
                        {preset.base_url || 'свой адрес'}
                      </code>
                    </div>
                  </div>
                  <p className="text-[11px] leading-4 text-[var(--text-muted)]">{preset.hint}</p>
                  <div className="mt-auto flex items-center gap-1.5 pt-0.5">
                    {preset.docs_url && (
                      <a
                        href={preset.docs_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`Документация ${preset.label}`}
                        className="inline-flex items-center gap-1 text-[10px] text-[var(--text-subtle)] hover:text-[var(--text)]"
                      >
                        Документация
                        <ExternalLink size={10} />
                      </a>
                    )}
                    <Button
                      variant="secondary"
                      size="sm"
                      className="ml-auto gap-1"
                      aria-label={`Подключить ${preset.label}`}
                      onClick={() => startCreate(preset)}
                    >
                      <Plus size={12} />
                      Подключить
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <p className="text-[11px] text-[var(--text-subtle)]">
        Ключи работают и из .env, но приоритет у vault. Модели по лейнам — в разделе «Модели».
      </p>
    </div>
  );
}

function ProviderFieldInput({
  field,
  value,
  onChange,
}: {
  field: ProviderField;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="space-y-1 text-[11px] text-[var(--text-muted)]">
      <span className="block font-medium">
        {field.label}
        {field.required ? ' *' : ''}
      </span>
      {field.kind === 'select' ? (
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-2 text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]"
        >
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          type={field.kind === 'number' ? 'number' : 'text'}
          inputMode={field.kind === 'number' ? 'decimal' : undefined}
          min={field.min}
          max={field.max}
          step={field.kind === 'number' ? 'any' : undefined}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          className="w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-2 text-xs font-mono text-[var(--text)] outline-none focus:border-[var(--accent)]"
        />
      )}
      {field.help && <span className="block text-[10px] text-[var(--text-subtle)]">{field.help}</span>}
    </label>
  );
}
