'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  Bot,
  Check,
  ChevronRight,
  Copy,
  Cpu,
  ExternalLink,
  Globe,
  Key,
  Loader2,
  MoreVertical,
  Plus,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  Sliders,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import { Button, IconButton, Badge, SoonAction } from '../ui';
import {
  isValidBaseUrl,
  isValidProviderName,
  type ProviderPreset,
  type ProviderRow,
  type ProvidersPayload,
} from '../../../lib/admin-providers';
import { playButtonClickSound } from '../../lib/ui-sounds';
import { emitToast, soonToast } from '../../lib/toast';

interface ProvidersSectionProps {
  onNavigateTab?: (tab: string) => void;
}

const DEFAULT_PRESETS: ProviderPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    base_url: 'https://api.openai.com/v1',
    kind: 'openai',
    needs_key: true,
    hint: 'GPT-4o, o1, o3-mini. Ключ sk-...',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    base_url: 'https://api.anthropic.com/v1',
    kind: 'anthropic',
    needs_key: true,
    hint: 'Claude 3.5 Sonnet, Claude 3.7. Ключ sk-ant-...',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    base_url: 'https://openrouter.ai/api/v1',
    kind: 'openai',
    needs_key: true,
    hint: 'Единый шлюз ко всем мировым моделям. Ключ sk-or-...',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    base_url: 'https://api.deepseek.com/v1',
    kind: 'openai',
    needs_key: true,
    hint: 'DeepSeek V3, R1. Ключ sk-...',
  },
  {
    id: 'groq',
    label: 'Groq',
    base_url: 'https://api.groq.com/openai/v1',
    kind: 'openai',
    needs_key: true,
    hint: 'Ультрабыстрый LPU инференс. Ключ gsk_...',
  },
  {
    id: 'mistral',
    label: 'Mistral AI',
    base_url: 'https://api.mistral.ai/v1',
    kind: 'openai',
    needs_key: true,
    hint: 'Mistral Large, Codestral. Ключ API...',
  },
  {
    id: 'ollama',
    label: 'Ollama (Local)',
    base_url: 'http://localhost:11434/v1',
    kind: 'local',
    needs_key: false,
    hint: 'Локальные модели на машине. Ключ не требуется.',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (Local)',
    base_url: 'http://localhost:1234/v1',
    kind: 'local',
    needs_key: false,
    hint: 'Локальный сервер LM Studio. Ключ не требуется.',
  },
  {
    id: 'custom',
    label: 'Кастомный шлюз',
    base_url: '',
    kind: 'openai',
    needs_key: true,
    hint: 'Любой OpenAI-совместимый сервер (vLLM, TGI, прокси).',
  },
];

interface VerifyResult {
  ok: boolean;
  models_count?: number;
  latency_ms?: number;
  models?: Array<{ id: string; name?: string }>;
  error?: string;
  message?: string;
  warning?: string;
}

export function ProvidersSection({ onNavigateTab }: ProvidersSectionProps) {
  const [data, setData] = useState<ProvidersPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Selected provider for Dedicated Provider Screen
  const [selectedProviderName, setSelectedProviderName] = useState<string | null>(null);

  // Add provider modal
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [addStep, setAddStep] = useState<1 | 2>(1);
  const [selectedPreset, setSelectedPreset] = useState<ProviderPreset | null>(null);
  const [formName, setFormName] = useState('');
  const [formBaseUrl, setFormBaseUrl] = useState('');
  const [formKind, setFormKind] = useState('openai');
  const [formKey, setFormKey] = useState('');
  const [addingProvider, setAddingProvider] = useState(false);
  const [addFormNotice, setAddFormNotice] = useState<string | null>(null);

  // Verification state per provider: providerName -> VerifyResult
  const [verificationMap, setVerificationMap] = useState<Record<string, VerifyResult>>({});
  const [verifyingProvider, setVerifyingProvider] = useState<string | null>(null);

  // In-place key editing state on cards: providerName -> string
  const [cardKeyInputs, setCardKeyInputs] = useState<Record<string, string>>({});
  const [changingKeyFor, setChangingKeyFor] = useState<string | null>(null);
  const [savingKeyFor, setSavingKeyFor] = useState<string | null>(null);

  // Menu action state
  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProviderRow | null>(null);
  const [deleteConfirmInput, setDeleteConfirmInput] = useState('');
  const [deletingProvider, setDeletingProvider] = useState(false);

  // OpenCode CLI modals
  const [cliAuthModalOpen, setCliAuthModalOpen] = useState(false);
  const [cliSetupModalOpen, setCliSetupModalOpen] = useState(false);
  const [cliCopied, setCliCopied] = useState(false);

  // Load providers from API
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

  const providers = useMemo(() => data?.providers ?? [], [data]);
  const presets = useMemo(() => {
    if (data?.presets && data.presets.length > 0) return data.presets;
    return DEFAULT_PRESETS;
  }, [data]);

  const selectedProvider = useMemo(
    () => providers.find((p) => p.name === selectedProviderName) ?? null,
    [providers, selectedProviderName],
  );

  // Close menus on outside click
  useEffect(() => {
    const handleOutsideClick = () => setActiveMenu(null);
    if (activeMenu) {
      window.addEventListener('click', handleOutsideClick);
      return () => window.removeEventListener('click', handleOutsideClick);
    }
  }, [activeMenu]);

  // Handle Verify Provider
  const handleVerify = async (name: string, baseUrl?: string, apiKey?: string) => {
    setVerifyingProvider(name);
    try {
      const res = await fetch(`/api/admin/providers/${encodeURIComponent(name)}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base_url: baseUrl, api_key: apiKey }),
      });
      const json = await res.json().catch(() => null);
      const result: VerifyResult = json?.data ?? json ?? { ok: false, message: 'Ошибка сети' };
      setVerificationMap((prev) => ({ ...prev, [name]: result }));

      if (result.ok) {
        emitToast({
          message: `Соединение успешно (${result.models_count ?? 0} моделей, ${result.latency_ms ?? 0} мс)`,
          tone: 'success',
        });
      } else {
        emitToast({
          message: result.message || 'Ошибка проверки провайдера',
          tone: 'danger',
        });
      }
      return result;
    } catch (err) {
      const fail: VerifyResult = {
        ok: false,
        message: err instanceof Error ? err.message : 'Ошибка сети при проверке',
      };
      setVerificationMap((prev) => ({ ...prev, [name]: fail }));
      emitToast({ message: fail.message!, tone: 'danger' });
      return fail;
    } finally {
      setVerifyingProvider(null);
    }
  };

  // Handle Save In-Place Key
  const handleSaveKey = async (name: string, keyVal: string) => {
    const cleanKey = keyVal.trim();
    if (!cleanKey) return;
    setSavingKeyFor(name);
    try {
      const res = await fetch(`/api/admin/providers/${encodeURIComponent(name)}/secret`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: cleanKey }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(json?.message || 'Не удалось сохранить ключ.');
      }
      // Wipe key from state and memory immediately
      setCardKeyInputs((prev) => {
        const copy = { ...prev };
        delete copy[name];
        return copy;
      });
      setChangingKeyFor(null);
      emitToast({ message: `Ключ для «${name}» сохранён в защищённое хранилище`, tone: 'success' });
      await load();
    } catch (err) {
      emitToast({ message: err instanceof Error ? err.message : 'Ошибка сохранения ключа', tone: 'danger' });
    } finally {
      setSavingKeyFor(null);
    }
  };

  // Handle Delete Key
  const handleDeleteKey = async (name: string) => {
    try {
      const res = await fetch(`/api/admin/providers/${encodeURIComponent(name)}/secret`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        throw new Error(json?.message || 'Не удалось удалить ключ.');
      }
      emitToast({ message: `Ключ провайдера «${name}» удалён`, tone: 'info' });
      await load();
    } catch (err) {
      emitToast({ message: err instanceof Error ? err.message : 'Ошибка удаления ключа', tone: 'danger' });
    }
  };

  // Handle Delete Provider
  const handleDeleteProvider = async (p: ProviderRow) => {
    if (deleteConfirmInput.trim().toLowerCase() !== p.name.toLowerCase()) return;
    setDeletingProvider(true);
    try {
      const res = await fetch(`/api/admin/providers/${encodeURIComponent(p.name)}`, {
        method: 'DELETE',
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        if (res.status === 409) {
          throw new Error('Нельзя удалить провайдера: он назначен в один или несколько активных лейнов.');
        }
        throw new Error(json?.message || 'Ядро не удалило провайдера.');
      }
      setDeleteTarget(null);
      setDeleteConfirmInput('');
      if (selectedProviderName === p.name) {
        setSelectedProviderName(null);
      }
      emitToast({ message: `Провайдер «${p.name}» успешно удалён`, tone: 'success' });
      await load();
    } catch (err) {
      emitToast({ message: err instanceof Error ? err.message : 'Ошибка удаления провайдера', tone: 'danger' });
    } finally {
      setDeletingProvider(false);
    }
  };

  // Handle Create Provider in Modal
  const handleCreateSubmit = async () => {
    const cleanName = formName.trim().toLowerCase();
    if (!isValidProviderName(cleanName)) {
      setAddFormNotice('Имя: строчные латинские буквы, цифры, дефис, точка или подчеркивание.');
      return;
    }
    if (!isValidBaseUrl(formBaseUrl)) {
      setAddFormNotice('Base URL должен начинаться с http:// или https:// и быть валидным URL.');
      return;
    }
    setAddingProvider(true);
    setAddFormNotice(null);
    try {
      const res = await fetch(`/api/admin/providers/${encodeURIComponent(cleanName)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base_url: formBaseUrl.trim(), kind: formKind }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.message || 'Ядро не приняло провайдера.');

      if (formKey.trim()) {
        const secRes = await fetch(`/api/admin/providers/${encodeURIComponent(cleanName)}/secret`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ api_key: formKey.trim() }),
        });
        if (!secRes.ok) {
          emitToast({ message: 'Провайдер создан, но ключ не был принят хранилищем', tone: 'danger' });
        }
      }

      setAddModalOpen(false);
      setAddStep(1);
      setFormKey('');
      setFormName('');
      setFormBaseUrl('');
      setSelectedPreset(null);
      emitToast({ message: `Провайдер «${cleanName}» успешно добавлен`, tone: 'success' });
      await load();
    } catch (err) {
      setAddFormNotice(err instanceof Error ? err.message : 'Не удалось добавить провайдера.');
    } finally {
      setAddingProvider(false);
    }
  };

  // Helper: Provider Logo / Icon
  const renderProviderIcon = (p: ProviderRow) => {
    const n = p.name.toLowerCase();
    if (n.includes('openai')) return <Bot size={18} className="text-[var(--text)]" />;
    if (n.includes('anthropic')) return <Cpu size={18} className="text-[#D97757]" />;
    if (n.includes('openrouter')) return <Globe size={18} className="text-[#6366F1]" />;
    if (n.includes('ollama') || n.includes('local') || n.includes('lmstudio'))
      return <Server size={18} className="text-[var(--text-muted)]" />;
    return <Cpu size={18} className="text-[var(--text-muted)]" />;
  };

  // Helper: Status dot & text
  const getStatusBadge = (p: ProviderRow) => {
    const isLocal = p.kind === 'local' || p.name === 'ollama' || p.name === 'lmstudio';
    if (p.has_key) {
      return (
        <div className="flex items-center gap-1.5 text-xs text-[var(--success)]">
          <span className="w-2 h-2 rounded-full bg-[var(--success)] shrink-0 animate-pulse" />
          <span className="font-medium">Ключ сохранён · скрыт</span>
        </div>
      );
    }
    if (isLocal) {
      return (
        <div className="flex items-center gap-1.5 text-xs text-[var(--success)]">
          <span className="w-2 h-2 rounded-full bg-[var(--success)] shrink-0" />
          <span className="font-medium">Локальный · ключ не требуется</span>
        </div>
      );
    }
    return (
      <div className="flex items-center gap-1.5 text-xs text-[var(--warn)]">
        <span className="w-2 h-2 rounded-full bg-[var(--warn)] shrink-0" />
        <span className="font-medium">Ключ не задан</span>
      </div>
    );
  };

  // Helper: Delete Provider Confirmation Modal
  const renderDeleteModal = () => {
    if (!deleteTarget) return null;
    return (
      <div className="fixed inset-0 z-[80] flex items-center justify-center p-3 sm:p-6">
        <div
          className="absolute inset-0 bg-black/75 backdrop-blur-sm animate-fade"
          onClick={() => setDeleteTarget(null)}
          aria-hidden="true"
        />

        <div
          role="dialog"
          aria-modal="true"
          aria-label="Удаление провайдера"
          className="relative w-full max-w-[440px] rounded-[var(--radius)] border border-[var(--danger)]/50 bg-[var(--surface)] shadow-panel animate-dialog p-5 space-y-4"
        >
          <div className="flex items-center justify-between border-b border-[var(--border)] pb-2.5">
            <h3 className="text-sm font-semibold text-[var(--danger)] flex items-center gap-1.5">
              <Trash2 size={15} />
              <span>Удаление провайдера</span>
            </h3>
            <IconButton
              aria-label="Закрыть"
              icon={<X size={15} />}
              variant="ghost"
              size="sm"
              onClick={() => setDeleteTarget(null)}
            />
          </div>

          <div className="space-y-3 text-xs">
            <p className="text-[var(--text-muted)] leading-relaxed">
              Вы собираетесь удалить провайдера <code className="font-semibold text-[var(--text)]">{deleteTarget.name}</code>. Связанный ключ в vault будет удален.
            </p>

            <label className="block space-y-1">
              <span className="text-[11px] text-[var(--text-muted)]">
                Для подтверждения введите имя провайдера (<strong>{deleteTarget.name}</strong>):
              </span>
              <input
                value={deleteConfirmInput}
                onChange={(e) => setDeleteConfirmInput(e.target.value)}
                placeholder={deleteTarget.name}
                className="w-full h-9 rounded-[var(--radius-sm)] border border-[var(--border-control)] bg-[var(--surface-2)] px-2.5 font-mono text-xs text-[var(--text)] outline-none focus:border-[var(--danger)]"
              />
            </label>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-[var(--border)]">
              <Button variant="secondary" size="sm" onClick={() => setDeleteTarget(null)}>
                Отмена
              </Button>
              <Button
                variant="danger"
                size="sm"
                loading={deletingProvider}
                disabled={
                  deletingProvider ||
                  deleteConfirmInput.trim().toLowerCase() !== deleteTarget.name.toLowerCase()
                }
                onClick={() => void handleDeleteProvider(deleteTarget)}
              >
                Удалить навсегда
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  };

  // -------------------------------------------------------------------------
  // VIEW: DEDICATED PROVIDER SCREEN
  // -------------------------------------------------------------------------
  if (selectedProvider) {
    const p = selectedProvider;
    const isLocal = p.kind === 'local' || p.name === 'ollama' || p.name === 'lmstudio';
    const verifyState = verificationMap[p.name];
    const candidateKey = cardKeyInputs[p.name] || '';
    const isVerifying = verifyingProvider === p.name;
    const isSavingKey = savingKeyFor === p.name;

    return (
      <div className="space-y-5 animate-in fade-in duration-150">
        {/* Breadcrumb & Navigation */}
        <div className="flex items-center justify-between border-b border-[var(--border)] pb-3">
          <div className="flex items-center gap-2 text-xs">
            <button
              type="button"
              onClick={() => setSelectedProviderName(null)}
              className="text-[var(--text-muted)] hover:text-[var(--text)] transition-colors cursor-pointer flex items-center gap-1"
            >
              <ArrowLeft size={14} />
              <span>Провайдеры</span>
            </button>
            <ChevronRight size={13} className="text-[var(--text-subtle)]" />
            <span className="font-semibold text-[var(--text)]">{p.label || p.name}</span>
          </div>

          <Button
            variant="secondary"
            size="sm"
            onClick={() => setSelectedProviderName(null)}
            className="text-xs"
          >
            Назад к списку
          </Button>
        </div>

        {/* 1. Header Section */}
        <div className="p-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-[var(--radius-sm)] bg-[var(--surface-2)] border border-[var(--border)] flex items-center justify-center">
              {renderProviderIcon(p)}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-semibold text-[var(--text)]">{p.label || p.name}</h3>
                <span className="font-mono text-xs text-[var(--text-subtle)]">({p.name})</span>
                {p.builtin ? (
                  <Badge tone="muted">Встроенный</Badge>
                ) : (
                  <Badge tone="default">Пользовательский</Badge>
                )}
              </div>
              <div className="mt-1">{getStatusBadge(p)}</div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              loading={isVerifying}
              disabled={isVerifying}
              onClick={() => void handleVerify(p.name, p.base_url, candidateKey || undefined)}
              className="text-xs gap-1.5"
            >
              <RefreshCw size={13} className={isVerifying ? 'animate-spin' : ''} />
              <span>Тест соединения</span>
            </Button>
          </div>
        </div>

        {/* 2. Connection Section */}
        <div className="p-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] space-y-3">
          <h4 className="text-xs font-semibold text-[var(--text)] flex items-center gap-1.5 border-b border-[var(--border)] pb-2">
            <Globe size={14} className="text-[var(--text-muted)]" />
            <span>Параметры подключения</span>
          </h4>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <div>
              <span className="text-[11px] text-[var(--text-muted)] block mb-1">Base URL</span>
              <div className="p-2 rounded bg-[var(--surface-2)] border border-[var(--border)] font-mono text-[11px] text-[var(--text)] truncate">
                {p.base_url || 'Не задан'}
              </div>
              {p.base_url.startsWith('http://') &&
                !p.base_url.includes('localhost') &&
                !p.base_url.includes('127.0.0.1') && (
                  <p className="mt-1 text-[11px] text-[var(--warn)] flex items-center gap-1">
                    <AlertCircle size={12} />
                    <span>Предупреждение: используется HTTP без шифрования TLS.</span>
                  </p>
                )}
            </div>

            <div>
              <span className="text-[11px] text-[var(--text-muted)] block mb-1">Тип адаптера</span>
              <div className="p-2 rounded bg-[var(--surface-2)] border border-[var(--border)] text-[11px] text-[var(--text)] capitalize">
                {p.kind}
              </div>
            </div>
          </div>
        </div>

        {/* 3. Access Key Section */}
        <div className="p-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] space-y-3">
          <div className="flex items-center justify-between border-b border-[var(--border)] pb-2">
            <h4 className="text-xs font-semibold text-[var(--text)] flex items-center gap-1.5">
              <Key size={14} className="text-[var(--text-muted)]" />
              <span>Ключ доступа (API Key)</span>
            </h4>
            {p.has_key && (
              <span className="text-[11px] text-[var(--text-subtle)] font-mono">
                Источник: {p.key_source}
              </span>
            )}
          </div>

          {p.has_key ? (
            <div className="p-3 rounded-[var(--radius-sm)] bg-[var(--surface-2)] border border-[var(--border)] flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <ShieldCheck size={16} className="text-[var(--success)]" />
                <div>
                  <div className="text-xs font-medium text-[var(--text)]">Ключ сохранён · скрыт</div>
                  <div className="text-[11px] text-[var(--text-subtle)]">
                    Значение хранится в шифрованном vault ядра и не передаётся в браузер.
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setChangingKeyFor(changingKeyFor === p.name ? null : p.name)}
                >
                  {changingKeyFor === p.name ? 'Скрыть поле' : 'Изменить ключ'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-[var(--danger)] hover:bg-[var(--danger-quiet)]"
                  onClick={() => void handleDeleteKey(p.name)}
                >
                  Удалить ключ
                </Button>
              </div>
            </div>
          ) : (
            <div className="p-3 rounded-[var(--radius-sm)] bg-[var(--surface-2)] border border-[var(--border)] text-xs text-[var(--text-muted)]">
              {isLocal
                ? 'Для локального шлюза ключ не требуется.'
                : 'Ключ не задан. Введите ключ для авторизации запросов к провайдеру.'}
            </div>
          )}

          {/* Key Input Field if absent or modifying */}
          {(!p.has_key || changingKeyFor === p.name) && (
            <div className="p-3 rounded-[var(--radius-sm)] bg-[var(--surface-3)] border border-[var(--border-control)] space-y-3">
              <label className="block space-y-1">
                <span className="text-[11px] font-medium text-[var(--text)]">
                  {p.has_key ? 'Новый API-ключ' : 'Введите API-ключ'}
                </span>
                <input
                  type="password"
                  autoComplete="new-password"
                  spellCheck={false}
                  value={candidateKey}
                  onChange={(e) =>
                    setCardKeyInputs((prev) => ({ ...prev, [p.name]: e.target.value }))
                  }
                  placeholder="sk-…"
                  className="w-full h-9 rounded-[var(--radius-sm)] border border-[var(--border-control)] bg-[var(--surface)] px-2.5 text-xs font-mono text-[var(--text)] outline-none focus:border-[var(--accent)] transition-colors"
                />
              </label>

              <div className="flex items-center gap-2 justify-end">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!candidateKey.trim() || isVerifying}
                  loading={isVerifying}
                  onClick={() => void handleVerify(p.name, p.base_url, candidateKey)}
                >
                  Проверить ключ
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!candidateKey.trim() || isSavingKey}
                  loading={isSavingKey}
                  onClick={() => void handleSaveKey(p.name, candidateKey)}
                >
                  Сохранить ключ
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* 4. Models Section */}
        <div className="p-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] space-y-3">
          <div className="flex items-center justify-between border-b border-[var(--border)] pb-2">
            <h4 className="text-xs font-semibold text-[var(--text)] flex items-center gap-1.5">
              <Cpu size={14} className="text-[var(--text-muted)]" />
              <span>Доступные модели</span>
            </h4>
            {verifyState?.ok && (
              <Badge tone="ok">
                {verifyState.models_count ?? verifyState.models?.length ?? 0} моделей найдено
              </Badge>
            )}
          </div>

          {verifyState?.models && verifyState.models.length > 0 ? (
            <div className="max-h-[260px] overflow-y-auto divide-y divide-[var(--border)] border border-[var(--border)] rounded-[var(--radius-sm)] bg-[var(--surface-2)]">
              {verifyState.models.map((m) => (
                <div key={m.id} className="p-2.5 flex items-center justify-between text-xs">
                  <div className="min-w-0 pr-2">
                    <div className="font-mono font-medium text-[var(--text)] truncate">{m.id}</div>
                    {m.name && m.name !== m.id && (
                      <div className="text-[10px] text-[var(--text-subtle)] truncate">{m.name}</div>
                    )}
                  </div>
                  <SoonAction featureName={`Назначение модели ${m.id} в лейн`}>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="text-[11px] h-7 whitespace-nowrap"
                      onClick={() =>
                        soonToast('Назначение модели в лейн', 'Управление лейнами доступно в разделе «Модели»')
                      }
                    >
                      Использовать в лейне…
                    </Button>
                  </SoonAction>
                </div>
              ))}
            </div>
          ) : (
            <div className="p-4 text-center rounded-[var(--radius-sm)] border border-dashed border-[var(--border)] space-y-2">
              <p className="text-xs text-[var(--text-muted)]">
                Список моделей не загружен. Выполните проверку соединения, чтобы получить актуальный список моделей от шлюза.
              </p>
              <Button
                variant="secondary"
                size="sm"
                loading={isVerifying}
                onClick={() => void handleVerify(p.name, p.base_url, candidateKey || undefined)}
              >
                Запросить модели (/models)
              </Button>
            </div>
          )}
        </div>

        {/* 5. Lanes Usage Section */}
        <div className="p-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] space-y-3">
          <div className="flex items-center justify-between border-b border-[var(--border)] pb-2">
            <h4 className="text-xs font-semibold text-[var(--text)] flex items-center gap-1.5">
              <Sliders size={14} className="text-[var(--text-muted)]" />
              <span>Использование в системе (Лейны)</span>
            </h4>
            {onNavigateTab && (
              <button
                type="button"
                onClick={() => onNavigateTab('models')}
                className="text-[11px] text-[var(--accent)] hover:underline cursor-pointer"
              >
                Перейти в «Модели» →
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {p.lanes.length > 0 ? (
              p.lanes.map((lane) => (
                <div
                  key={lane}
                  className="px-2.5 py-1 rounded-[var(--radius-sm)] bg-[var(--surface-2)] border border-[var(--border-strong)] text-xs font-medium text-[var(--text)] flex items-center gap-1.5"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--success)]" />
                  <span className="uppercase font-mono text-[10px] tracking-wide">{lane}</span>
                </div>
              ))
            ) : (
              <div className="flex items-center justify-between w-full p-2.5 rounded bg-[var(--surface-2)] border border-[var(--border)] text-xs text-[var(--text-muted)]">
                <span>Провайдер не назначен ни в один активный лейн.</span>
                {onNavigateTab && (
                  <Button variant="secondary" size="sm" onClick={() => onNavigateTab('models')}>
                    Назначить в лейн
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>

        {/* 6. Danger Zone Section */}
        {!p.builtin && (
          <div className="p-4 rounded-[var(--radius)] border border-[var(--danger)]/30 bg-[var(--danger-quiet)] space-y-3">
            <h4 className="text-xs font-semibold text-[var(--danger)] flex items-center gap-1.5">
              <Trash2 size={14} />
              <span>Опасная зона</span>
            </h4>

            <p className="text-xs text-[var(--danger)]/90 leading-relaxed">
              Удаление провайдера стирает его настройки и удаляет связанный API-ключ. Если провайдер используется в активных лейнах ядра, удаление будет заблокировано.
            </p>

            {p.lanes.length > 0 ? (
              <div className="p-2.5 rounded bg-[var(--surface)] border border-[var(--danger)]/30 text-xs text-[var(--danger)]">
                Провайдер используется в лейнах ({p.lanes.join(', ')}). Сначала переназначьте эти лейны в разделе «Модели».
              </div>
            ) : (
              <Button
                variant="danger"
                size="sm"
                onClick={() => {
                  setDeleteTarget(p);
                  setDeleteConfirmInput('');
                }}
              >
                Удалить провайдера…
              </Button>
            )}
          </div>
        )}

        {/* Delete Confirmation Modal */}
        {renderDeleteModal()}
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // VIEW: MAIN GRID OF PROVIDER CARDS + CLI BLOCK
  // -------------------------------------------------------------------------
  return (
    <div className="space-y-6">
      {/* Header Bar */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-[var(--text)]">Провайдеры</h3>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            Подключение шлюзов моделей: OpenAI-совместимые API, локальные серверы и CLI-провайдеры.
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
          <Button
            variant="primary"
            size="sm"
            className="gap-1.5"
            onClick={() => {
              playButtonClickSound();
              setAddModalOpen(true);
              setAddStep(1);
              setSelectedPreset(null);
              setFormName('');
              setFormBaseUrl('');
              setFormKey('');
              setAddFormNotice(null);
            }}
          >
            <Plus size={14} />
            Добавить провайдера
          </Button>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="flex items-center gap-2 p-3 rounded-[var(--radius-sm)] border border-[var(--danger)]/40 bg-[var(--danger-quiet)] text-xs text-[var(--danger)]"
        >
          <AlertCircle size={14} />
          <span>{error}</span>
          <Button variant="secondary" size="sm" className="ml-auto" onClick={() => void load()}>
            Повторить
          </Button>
        </div>
      )}

      {notice && (
        <div
          role="status"
          className="flex items-center gap-2 p-3 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--surface-3)] text-xs text-[var(--text)]"
        >
          <Check size={14} />
          <span>{notice}</span>
          <IconButton
            aria-label="Скрыть"
            icon={<X size={12} />}
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => setNotice(null)}
          />
        </div>
      )}

      {/* Grid of Providers: 1 col on 390, 2 on 768, 3 on 1440 */}
      <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-3.5">
        {providers.length === 0 && !loading && (
          <div className="col-span-full flex flex-col items-center gap-2 py-10 text-center rounded-[var(--radius)] border border-dashed border-[var(--border)]">
            <Server size={20} className="text-[var(--text-subtle)]" />
            <p className="text-xs font-medium text-[var(--text)]">Пока нет провайдеров</p>
            <p className="text-[11px] text-[var(--text-muted)] max-w-[360px]">
              Пока нет провайдеров. Добавьте OpenAI-совместимый шлюз или локальную модель.
            </p>
            <Button
              variant="primary"
              size="sm"
              className="mt-1"
              onClick={() => {
                setAddModalOpen(true);
                setAddStep(1);
              }}
            >
              Добавить провайдера
            </Button>
          </div>
        )}

        {providers.map((p) => {
          const isLocal = p.kind === 'local' || p.name === 'ollama' || p.name === 'lmstudio';
          const verifyState = verificationMap[p.name];
          const isVerifying = verifyingProvider === p.name;
          const isSavingKey = savingKeyFor === p.name;
          const inputKey = cardKeyInputs[p.name] || '';
          const isChangingKey = changingKeyFor === p.name;

          return (
            <div
              key={p.name}
              data-provider-card={p.name}
              onClick={() => {
                playButtonClickSound();
                setSelectedProviderName(p.name);
              }}
              className="group relative rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3.5 space-y-3 transition-all hover:border-[var(--border-strong)] hover:shadow-sm cursor-pointer flex flex-col justify-between"
            >
              {/* Card Top: Icon, Titles, Status */}
              <div className="space-y-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="w-8 h-8 rounded-[var(--radius-sm)] bg-[var(--surface-2)] border border-[var(--border)] flex items-center justify-center shrink-0">
                      {renderProviderIcon(p)}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-semibold text-[var(--text)] truncate">
                          {p.label || p.name}
                        </span>
                        {!p.builtin && (
                          <span className="text-[9px] px-1 py-0.2 rounded border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-subtle)]">
                            свой
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] font-mono text-[var(--text-subtle)] truncate">
                        {p.name}
                      </div>
                    </div>
                  </div>

                  {/* Actions Dropdown Trigger */}
                  <div
                    className="relative shrink-0"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <IconButton
                      icon={<MoreVertical size={13} />}
                      aria-label="Действия с провайдером"
                      variant="ghost"
                      size="sm"
                      className="w-7 h-7"
                      onClick={() => setActiveMenu(activeMenu === p.name ? null : p.name)}
                    />

                    {activeMenu === p.name && (
                      <div className="absolute right-0 top-8 z-30 w-44 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--surface-2)] shadow-panel p-1 text-xs space-y-0.5 animate-in fade-in zoom-in-95 duration-100">
                        <button
                          type="button"
                          className="w-full text-left px-2.5 py-1.5 rounded hover:bg-[var(--surface-3)] text-[var(--text)] flex items-center gap-1.5 cursor-pointer"
                          onClick={() => {
                            setActiveMenu(null);
                            void handleVerify(p.name, p.base_url, inputKey || undefined);
                          }}
                        >
                          <RefreshCw size={12} />
                          <span>Проверить связь</span>
                        </button>
                        <button
                          type="button"
                          className="w-full text-left px-2.5 py-1.5 rounded hover:bg-[var(--surface-3)] text-[var(--text)] flex items-center gap-1.5 cursor-pointer"
                          onClick={() => {
                            setActiveMenu(null);
                            setSelectedProviderName(p.name);
                          }}
                        >
                          <Sliders size={12} />
                          <span>Открыть экран</span>
                        </button>
                        {p.has_key && (
                          <button
                            type="button"
                            className="w-full text-left px-2.5 py-1.5 rounded hover:bg-[var(--danger-quiet)] text-[var(--danger)] flex items-center gap-1.5 cursor-pointer"
                            onClick={() => {
                              setActiveMenu(null);
                              void handleDeleteKey(p.name);
                            }}
                          >
                            <Key size={12} />
                            <span>Удалить ключ</span>
                          </button>
                        )}
                        {!p.builtin && (
                          <button
                            type="button"
                            className="w-full text-left px-2.5 py-1.5 rounded hover:bg-[var(--danger-quiet)] text-[var(--danger)] flex items-center gap-1.5 cursor-pointer border-t border-[var(--border)] mt-0.5"
                            onClick={() => {
                              setActiveMenu(null);
                              setDeleteTarget(p);
                              setDeleteConfirmInput('');
                            }}
                          >
                            <Trash2 size={12} />
                            <span>Удалить провайдера</span>
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {/* Status Dot & Info */}
                <div>{getStatusBadge(p)}</div>

                {/* Verification result snippet */}
                {verifyState && (
                  <div
                    className={`p-2 rounded text-[11px] leading-tight flex items-center gap-1.5 ${
                      verifyState.ok
                        ? 'bg-[var(--surface-2)] text-[var(--success)] border border-[var(--success)]/20'
                        : 'bg-[var(--danger-quiet)] text-[var(--danger)] border border-[var(--danger)]/30'
                    }`}
                  >
                    {verifyState.ok ? (
                      <>
                        <Check size={12} className="shrink-0" />
                        <span>
                          {verifyState.models_count ?? 0} моделей доступно ({verifyState.latency_ms ?? 0} мс)
                        </span>
                      </>
                    ) : (
                      <>
                        <AlertCircle size={12} className="shrink-0" />
                        <span className="truncate">{verifyState.message || 'Ошибка подключения'}</span>
                      </>
                    )}
                  </div>
                )}

                {/* Lanes Chips */}
                <div className="flex flex-wrap items-center gap-1 pt-1">
                  {p.lanes.length > 0 ? (
                    p.lanes.map((lane) => (
                      <span
                        key={lane}
                        className="text-[10px] px-1.5 py-0.5 rounded border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-muted)]"
                      >
                        {lane}
                      </span>
                    ))
                  ) : (
                    <span className="text-[10px] text-[var(--text-subtle)]">не занят в лейнах</span>
                  )}
                </div>
              </div>

              {/* Card Bottom: Key State Machine / In-Place Key Entry */}
              <div
                className="pt-2 border-t border-[var(--border)] mt-2"
                onClick={(e) => e.stopPropagation()}
              >
                {p.has_key && !isChangingKey ? (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] text-[var(--text-subtle)]">Ключ скрыт в vault</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-[11px] h-7 px-2"
                      onClick={() => setChangingKeyFor(p.name)}
                    >
                      Изменить ключ
                    </Button>
                  </div>
                ) : isLocal && !isChangingKey ? (
                  <div className="text-[11px] text-[var(--text-subtle)]">
                    Адрес: <code className="text-[var(--text-muted)]">{p.base_url}</code>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="relative">
                      <input
                        type="password"
                        autoComplete="new-password"
                        spellCheck={false}
                        value={inputKey}
                        onChange={(e) =>
                          setCardKeyInputs((prev) => ({ ...prev, [p.name]: e.target.value }))
                        }
                        placeholder={p.has_key ? 'Новый ключ sk-…' : 'sk-…'}
                        className="w-full h-8 rounded-[var(--radius-sm)] border border-[var(--border-control)] bg-[var(--surface-2)] px-2.5 text-xs font-mono text-[var(--text)] outline-none focus:border-[var(--accent)]"
                      />
                    </div>
                    <div className="flex items-center justify-between gap-1.5">
                      {isChangingKey && (
                        <button
                          type="button"
                          onClick={() => setChangingKeyFor(null)}
                          className="text-[11px] text-[var(--text-subtle)] hover:text-[var(--text)] cursor-pointer"
                        >
                          Отмена
                        </button>
                      )}
                      <div className="flex items-center gap-1.5 ml-auto">
                        <Button
                          variant="secondary"
                          size="sm"
                          className="h-7 text-[11px]"
                          disabled={!inputKey.trim() || isVerifying}
                          loading={isVerifying}
                          onClick={() => void handleVerify(p.name, p.base_url, inputKey)}
                        >
                          Проверить
                        </Button>
                        <Button
                          variant={verifyState?.ok ? 'primary' : 'secondary'}
                          size="sm"
                          className="h-7 text-[11px]"
                          disabled={!inputKey.trim() || isSavingKey}
                          loading={isSavingKey}
                          onClick={() => void handleSaveKey(p.name, inputKey)}
                        >
                          Сохранить
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* ------------------------------------------------------------------- */}
      {/* CLI PROVIDERS BLOCK (OpenCode)                                      */}
      {/* ------------------------------------------------------------------- */}
      <div className="pt-2 border-t border-[var(--border)] space-y-3">
        <div>
          <h4 className="text-sm font-semibold text-[var(--text)] flex items-center gap-2">
            <Terminal size={16} className="text-[var(--text-muted)]" />
            <span>CLI-провайдеры (OpenCode)</span>
          </h4>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            Использование локального OpenCode CLI для моделей, требующих веб-авторизации или локального контекста разработчика.
          </p>
        </div>

        <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="flex items-start gap-3 min-w-0">
            <div className="w-10 h-10 rounded-[var(--radius-sm)] bg-[var(--surface-2)] border border-[var(--border)] flex items-center justify-center shrink-0">
              <Terminal size={18} className="text-[var(--text)]" />
            </div>
            <div className="space-y-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-[var(--text)]">OpenCode CLI Bridge</span>
                <span className="px-1.5 py-0.2 rounded text-[10px] bg-[var(--surface-3)] text-[var(--text-subtle)] border border-[var(--border)]">
                  Локальный
                </span>
                <span className="flex items-center gap-1 text-[11px] text-[var(--text-subtle)]">
                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--text-subtle)]" />
                  CLI не обнаружен
                </span>
              </div>
              <p className="text-xs text-[var(--text-muted)] leading-relaxed">
                Позволяет использовать ваши существующие подписки (ChatGPT Plus/Team, Claude Pro) без прямых API-ключей через терминальный шлюз.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0 w-full sm:w-auto">
            <Button
              variant="secondary"
              size="sm"
              className="text-xs flex-1 sm:flex-none"
              onClick={() => setCliSetupModalOpen(true)}
            >
              Инструкция
            </Button>
            <Button
              variant="primary"
              size="sm"
              className="text-xs flex-1 sm:flex-none gap-1.5"
              onClick={() => setCliAuthModalOpen(true)}
            >
              <Terminal size={13} />
              <span>Авторизация в терминале</span>
            </Button>
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------------------- */}
      {/* 2-STEP ADD PROVIDER MODAL                                           */}
      {/* ------------------------------------------------------------------- */}
      {addModalOpen && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center p-3 sm:p-6">
          <div
            className="absolute inset-0 bg-black/75 backdrop-blur-sm animate-fade"
            onClick={() => setAddModalOpen(false)}
            aria-hidden="true"
          />

          <div
            role="dialog"
            aria-modal="true"
            aria-label="Добавить провайдера"
            className="relative w-full max-w-[540px] rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--surface)] shadow-panel animate-dialog p-5 space-y-4"
          >
            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-[var(--border)] pb-3">
              <div>
                <h3 className="text-sm font-semibold text-[var(--text)]">
                  {addStep === 1 ? 'Шаг 1: Выберите готовый шлюз' : 'Шаг 2: Настройка подключения'}
                </h3>
                <p className="text-[11px] text-[var(--text-subtle)] mt-0.5">
                  {addStep === 1
                    ? 'Выберите популярный провайдер или создайте кастомное подключение'
                    : `Конфигурация параметров для «${selectedPreset?.label || formName}»`}
                </p>
              </div>
              <IconButton
                aria-label="Закрыть"
                icon={<X size={15} />}
                variant="ghost"
                size="sm"
                onClick={() => setAddModalOpen(false)}
              />
            </div>

            {addFormNotice && (
              <div className="p-2.5 rounded bg-[var(--danger-quiet)] border border-[var(--danger)]/30 text-xs text-[var(--danger)] flex items-center gap-2">
                <AlertCircle size={13} className="shrink-0" />
                <span>{addFormNotice}</span>
              </div>
            )}

            {/* STEP 1: PRESET SELECTION */}
            {addStep === 1 && (
              <div className="space-y-3">
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {presets.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => {
                        setSelectedPreset(preset);
                        setFormName(preset.id !== 'custom' ? preset.id : '');
                        setFormBaseUrl(preset.base_url || '');
                        setFormKind(preset.kind || 'openai');
                        setAddStep(2);
                      }}
                      className="p-3 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] hover:border-[var(--accent)] hover:bg-[var(--surface-3)] text-left transition-all cursor-pointer group flex flex-col justify-between min-h-[76px]"
                    >
                      <div className="font-semibold text-xs text-[var(--text)] group-hover:text-[var(--accent)]">
                        {preset.label}
                      </div>
                      <div className="text-[10px] text-[var(--text-subtle)] truncate">
                        {preset.base_url || 'свой URL'}
                      </div>
                    </button>
                  ))}
                </div>

                <div className="pt-2 flex justify-end">
                  <Button variant="ghost" size="sm" onClick={() => setAddModalOpen(false)}>
                    Отмена
                  </Button>
                </div>
              </div>
            )}

            {/* STEP 2: CONFIGURATION FORM */}
            {addStep === 2 && (
              <div className="space-y-3 text-xs">
                <div className="space-y-1">
                  <span className="font-medium text-[var(--text)]">Имя провайдера (латиницей)</span>
                  <input
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                    placeholder="my-gateway"
                    className="w-full h-9 rounded-[var(--radius-sm)] border border-[var(--border-control)] bg-[var(--surface-2)] px-2.5 font-mono text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]"
                  />
                  <span className="text-[10px] text-[var(--text-subtle)]">
                    Уникальный идентификатор в ядре (a-z, 0-9, . - _)
                  </span>
                </div>

                <div className="space-y-1">
                  <span className="font-medium text-[var(--text)]">Base URL</span>
                  <input
                    value={formBaseUrl}
                    onChange={(e) => setFormBaseUrl(e.target.value)}
                    placeholder="https://api.example.com/v1"
                    className="w-full h-9 rounded-[var(--radius-sm)] border border-[var(--border-control)] bg-[var(--surface-2)] px-2.5 font-mono text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]"
                  />
                </div>

                <div className="space-y-1">
                  <span className="font-medium text-[var(--text)]">
                    API-ключ {selectedPreset?.needs_key ? '(обязательно для облачных)' : '(опционально)'}
                  </span>
                  <input
                    type="password"
                    autoComplete="new-password"
                    spellCheck={false}
                    value={formKey}
                    onChange={(e) => setFormKey(e.target.value)}
                    placeholder="sk-…"
                    className="w-full h-9 rounded-[var(--radius-sm)] border border-[var(--border-control)] bg-[var(--surface-2)] px-2.5 font-mono text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]"
                  />
                </div>

                <div className="pt-2 border-t border-[var(--border)] flex items-center justify-between">
                  <Button variant="secondary" size="sm" onClick={() => setAddStep(1)}>
                    Назад к пресетам
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    loading={addingProvider}
                    disabled={addingProvider || !formName.trim() || !formBaseUrl.trim()}
                    onClick={() => void handleCreateSubmit()}
                  >
                    Добавить провайдера
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------- */}
      {/* DELETE PROVIDER CONFIRMATION MODAL                                  */}
      {/* ------------------------------------------------------------------- */}
      {renderDeleteModal()}

      {/* ------------------------------------------------------------------- */}
      {/* OPENCODE CLI COMMAND MODAL                                          */}
      {/* ------------------------------------------------------------------- */}
      {cliAuthModalOpen && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center p-3 sm:p-6">
          <div
            className="absolute inset-0 bg-black/75 backdrop-blur-sm animate-fade"
            onClick={() => setCliAuthModalOpen(false)}
            aria-hidden="true"
          />

          <div
            role="dialog"
            aria-modal="true"
            aria-label="Авторизация через OpenCode CLI"
            className="relative w-full max-w-[500px] rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--surface)] shadow-panel animate-dialog p-5 space-y-4"
          >
            <div className="flex items-center justify-between border-b border-[var(--border)] pb-2.5">
              <h3 className="text-sm font-semibold text-[var(--text)] flex items-center gap-2">
                <Terminal size={15} />
                <span>Авторизация в OpenCode CLI</span>
              </h3>
              <IconButton
                aria-label="Закрыть"
                icon={<X size={15} />}
                variant="ghost"
                size="sm"
                onClick={() => setCliAuthModalOpen(false)}
              />
            </div>

            <div className="space-y-3 text-xs leading-relaxed text-[var(--text-muted)]">
              <p>
                Выполните команду в терминале на машине, где запущен сервер Neyra, чтобы авторизовать локальный OpenCode CLI:
              </p>

              <div className="flex items-center justify-between p-2.5 rounded bg-[var(--surface-2)] border border-[var(--border)] font-mono text-xs text-[var(--text)]">
                <code>opencode auth login</code>
                <Button
                  variant="secondary"
                  size="sm"
                  className="h-7 text-xs gap-1"
                  onClick={() => {
                    navigator.clipboard.writeText('opencode auth login');
                    setCliCopied(true);
                    setTimeout(() => setCliCopied(false), 2000);
                  }}
                >
                  {cliCopied ? <Check size={12} /> : <Copy size={12} />}
                  <span>{cliCopied ? 'Скопировано' : 'Копировать'}</span>
                </Button>
              </div>

              <div className="p-3 rounded bg-[var(--surface-3)] border border-[var(--border)] text-[11px] text-[var(--text-subtle)] space-y-1">
                <div className="font-semibold text-[var(--text)]">Честный статус:</div>
                <p>
                  После выполнения команды локальный демон OpenCode сохранит сессионный токен. Веб-интерфейс автоматически обнаружит авторизацию при перезапуске ядра.
                </p>
              </div>

              <div className="flex justify-end pt-2 border-t border-[var(--border)]">
                <Button variant="secondary" size="sm" onClick={() => setCliAuthModalOpen(false)}>
                  Закрыть
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------- */}
      {/* OPENCODE CLI SETUP MODAL                                            */}
      {/* ------------------------------------------------------------------- */}
      {cliSetupModalOpen && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center p-3 sm:p-6">
          <div
            className="absolute inset-0 bg-black/75 backdrop-blur-sm animate-fade"
            onClick={() => setCliSetupModalOpen(false)}
            aria-hidden="true"
          />

          <div
            role="dialog"
            aria-modal="true"
            aria-label="Инструкция по установке OpenCode"
            className="relative w-full max-w-[500px] rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--surface)] shadow-panel animate-dialog p-5 space-y-4"
          >
            <div className="flex items-center justify-between border-b border-[var(--border)] pb-2.5">
              <h3 className="text-sm font-semibold text-[var(--text)] flex items-center gap-2">
                <Terminal size={15} />
                <span>Установка OpenCode CLI</span>
              </h3>
              <IconButton
                aria-label="Закрыть"
                icon={<X size={15} />}
                variant="ghost"
                size="sm"
                onClick={() => setCliSetupModalOpen(false)}
              />
            </div>

            <div className="space-y-3 text-xs leading-relaxed text-[var(--text-muted)]">
              <p>Установите OpenCode CLI на целевой сервер с помощью одной команды:</p>

              <div className="flex items-center justify-between p-2.5 rounded bg-[var(--surface-2)] border border-[var(--border)] font-mono text-xs text-[var(--text)]">
                <code className="truncate">curl -fsSL https://opencode.ai/install.sh | bash</code>
                <Button
                  variant="secondary"
                  size="sm"
                  className="h-7 text-xs gap-1 shrink-0 ml-2"
                  onClick={() => {
                    navigator.clipboard.writeText('curl -fsSL https://opencode.ai/install.sh | bash');
                    emitToast({ message: 'Команда скопирована', tone: 'success' });
                  }}
                >
                  <Copy size={12} />
                  <span>Копировать</span>
                </Button>
              </div>

              <ol className="list-decimal pl-4 space-y-1.5 text-[11px] text-[var(--text-subtle)]">
                <li>Убедитесь, что у процесса есть права на выполнение.</li>
                <li>Запустите <code>opencode auth login</code> для привязки аккаунта.</li>
                <li>В конфигурации ядра укажите провайдер <code>opencode</code>.</li>
              </ol>

              <div className="flex justify-end pt-2 border-t border-[var(--border)]">
                <Button variant="secondary" size="sm" onClick={() => setCliSetupModalOpen(false)}>
                  Понятно
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
