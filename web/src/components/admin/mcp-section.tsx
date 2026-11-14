'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Check,
  Loader2,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  RotateCw,
  Server,
  ShieldAlert,
  Trash2,
  X,
} from 'lucide-react';
import { Button, IconButton } from '../ui';
import {
  MCP_ENV_NAME_RE,
  MAX_MCP_ARGS,
  MAX_MCP_ENV,
  type McpEnvVar,
  type McpPayload,
  type McpServer,
  type McpStatus,
  type McpTransport,
  type McpWriteBody,
  validateMcpApiBody,
} from '../../../lib/admin-mcp';
import { playButtonClickSound } from '../../lib/ui-sounds';

const STATUS_META: Record<McpStatus, { label: string; dot: string; pill: string }> = {
  connected: {
    label: 'подключён',
    dot: 'bg-[var(--success)]',
    pill: 'border-[var(--border-strong)] bg-[var(--surface-3)] text-[var(--text)]',
  },
  error: {
    label: 'ошибка',
    dot: 'bg-[var(--danger)]',
    pill: 'border-[var(--danger)]/40 bg-[var(--danger-quiet)] text-[var(--danger)]',
  },
  disabled: {
    label: 'выключен',
    dot: 'bg-[var(--text-subtle)]',
    pill: 'border-[var(--border)] bg-transparent text-[var(--text-subtle)]',
  },
  disconnected: {
    label: 'не подключён',
    dot: 'bg-[var(--text-muted)]',
    pill: 'border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-muted)]',
  },
};

const TRANSPORT_LABEL: Record<McpTransport, string> = {
  stdio: 'stdio',
  sse: 'SSE',
};

const dateFormat = new Intl.DateTimeFormat('ru-RU', {
  dateStyle: 'short',
  timeStyle: 'medium',
  timeZone: 'Europe/Moscow',
});

function formatChecked(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return `${dateFormat.format(date)} МСК`;
}

function parseArgs(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

interface EnvDraft {
  id: string;
  name: string;
  value: string;
  existing: boolean;
}

interface Draft {
  mode: 'create' | 'edit';
  original?: string;
  name: string;
  transport: McpTransport;
  command: string;
  argsText: string;
  url: string;
  cwd: string;
  enabled: boolean;
  env: EnvDraft[];
  replaceEnv: boolean;
}

let envSeq = 0;
function newEnvRow(name = '', existing = false): EnvDraft {
  envSeq += 1;
  return { id: `env-${envSeq}`, name, value: '', existing };
}

function draftFromServer(server: McpServer): Draft {
  return {
    mode: 'edit',
    original: server.name,
    name: server.name,
    transport: server.transport,
    command: server.command ?? '',
    argsText: (server.args ?? []).join('\n'),
    url: server.url ?? '',
    cwd: server.cwd ?? '',
    enabled: server.enabled,
    env: server.env.map((item) => newEnvRow(item.name, true)),
    replaceEnv: false,
  };
}

interface Feedback {
  tone: 'ok' | 'error';
  text: string;
}

function StatusDot({ status }: { status: McpStatus }) {
  const meta = STATUS_META[status] ?? STATUS_META.disconnected;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} aria-hidden="true" />
      <span>{meta.label}</span>
    </span>
  );
}

function EnvBadge({ item }: { item: McpEnvVar }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1">
      <span className="font-mono text-[10px] text-[var(--text)]">{item.name}</span>
      <span className={`text-[10px] ${item.set ? 'text-[var(--text-muted)]' : 'text-[var(--text-subtle)]'}`}>
        {item.set ? 'задан' : 'не задан'}
      </span>
    </span>
  );
}

export function McpSection() {
  const [data, setData] = useState<McpPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [form, setForm] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/admin/mcp/servers', { cache: 'no-store' });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.message || 'Ядро не отдало MCP-серверы.');
      setData(payload?.data ?? payload);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось загрузить MCP-серверы.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const servers = data?.servers ?? [];
  const errorCount = servers.filter((server) => server.status === 'error').length;
  const connectedCount = servers.filter((server) => server.status === 'connected').length;

  const startCreate = () => {
    playButtonClickSound();
    setFeedback(null);
    setConfirmDelete(null);
    setForm({
      mode: 'create',
      name: '',
      transport: 'stdio',
      command: '',
      argsText: '',
      url: '',
      cwd: '',
      enabled: true,
      env: [],
      replaceEnv: true,
    });
  };

  const startEdit = (server: McpServer) => {
    playButtonClickSound();
    setFeedback(null);
    setConfirmDelete(null);
    setForm(draftFromServer(server));
  };

  const closeForm = () => {
    setForm(null);
    setFeedback(null);
  };

  const setDraft = (patch: Partial<Draft>) => {
    setForm((current) => (current ? { ...current, ...patch } : current));
  };

  const setEnvRow = (id: string, patch: Partial<EnvDraft>) => {
    setForm((current) =>
      current
        ? { ...current, env: current.env.map((row) => (row.id === id ? { ...row, ...patch } : row)) }
        : current,
    );
  };

  const addEnvRow = () => {
    setForm((current) => (current ? { ...current, env: [...current.env, newEnvRow()] } : current));
  };

  const removeEnvRow = (id: string) => {
    setForm((current) => (current ? { ...current, env: current.env.filter((row) => row.id !== id) } : current));
  };

  const resetEnv = (original: McpServer) => {
    setDraft({ env: original.env.map((item) => newEnvRow(item.name, true)), replaceEnv: false });
  };

  const buildBody = (draft: Draft): { ok: true; body: McpWriteBody } | { ok: false; message: string } => {
    const envEnabled = draft.mode === 'create' || draft.replaceEnv;
    const env: Record<string, string> = {};
    if (envEnabled) {
      const seen = new Set<string>();
      for (const row of draft.env) {
        const name = row.name.trim();
        const value = row.value;
        if (!name) {
          if (value.trim()) return { ok: false, message: 'У переменной окружения не задано имя.' };
          continue;
        }
        if (!MCP_ENV_NAME_RE.test(name)) {
          return {
            ok: false,
            message: `Переменная «${name}»: имя из латиницы, цифр и _, не начинается с цифры.`,
          };
        }
        if (seen.has(name)) return { ok: false, message: `Переменная «${name}» указана дважды.` };
        seen.add(name);
        if (!value.trim()) {
          return { ok: false, message: `Переменная «${name}»: введите значение.` };
        }
        env[name] = value;
      }
      if (Object.keys(env).length > MAX_MCP_ENV) {
        return { ok: false, message: `Переменных окружения: не больше ${MAX_MCP_ENV}.` };
      }
    }

    const raw: Record<string, unknown> = {
      transport: draft.transport,
      enabled: draft.enabled,
      cwd: draft.cwd.trim(),
    };
    if (draft.mode === 'create') raw.name = draft.name.trim();
    if (draft.transport === 'stdio') {
      raw.command = draft.command.trim();
      raw.args = parseArgs(draft.argsText);
    } else {
      raw.url = draft.url.trim();
    }
    if (envEnabled) raw.env = env;

    const parsed = validateMcpApiBody(raw, { requireName: draft.mode === 'create' });
    if (parsed.ok === false) return { ok: false, message: parsed.message };
    return { ok: true, body: parsed.value };
  };

  const submit = async () => {
    if (!form) return;
    const built = buildBody(form);
    if (built.ok === false) {
      setFeedback({ tone: 'error', text: built.message });
      return;
    }
    setSaving(true);
    setFeedback(null);
    try {
      const url =
        form.mode === 'create'
          ? '/api/admin/mcp/servers'
          : `/api/admin/mcp/servers/${encodeURIComponent(form.original ?? form.name)}`;
      const response = await fetch(url, {
        method: form.mode === 'create' ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(built.body),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.message || 'Ядро не приняло настройки MCP.');
      setData(payload?.data ?? payload);
      setFeedback({
        tone: 'ok',
        text:
          form.mode === 'create'
            ? `Сервер «${form.name.trim()}» добавлен. Ядро подключает его без перезапуска.`
            : `Настройки «${form.name}» сохранены.`,
      });
      setForm(null);
    } catch (e) {
      setFeedback({ tone: 'error', text: e instanceof Error ? e.message : 'Не удалось сохранить сервер.' });
    } finally {
      setSaving(false);
    }
  };

  const restart = async (name: string) => {
    setBusy(`restart:${name}`);
    setFeedback(null);
    try {
      const response = await fetch(`/api/admin/mcp/servers/${encodeURIComponent(name)}/restart`, { method: 'POST' });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.message || 'Ядро не переподключило сервер.');
      setData(payload?.data ?? payload);
      setFeedback({ tone: 'ok', text: `Сервер «${name}» переподключён.` });
    } catch (e) {
      setFeedback({ tone: 'error', text: e instanceof Error ? e.message : 'Не удалось переподключить сервер.' });
    } finally {
      setBusy(null);
    }
  };

  const reloadAll = async () => {
    setBusy('reload');
    setFeedback(null);
    try {
      const response = await fetch('/api/admin/mcp/reload', { method: 'POST' });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.message || 'Ядро не перечитало MCP.');
      setData(payload?.data ?? payload);
      setFeedback({ tone: 'ok', text: 'Конфигурация MCP перечитана, серверы переподключены.' });
    } catch (e) {
      setFeedback({ tone: 'error', text: e instanceof Error ? e.message : 'Не удалось перечитать конфигурацию.' });
    } finally {
      setBusy(null);
    }
  };

  const remove = async (name: string) => {
    setBusy(`delete:${name}`);
    setFeedback(null);
    try {
      const response = await fetch(`/api/admin/mcp/servers/${encodeURIComponent(name)}`, { method: 'DELETE' });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.message || 'Ядро не удалило сервер.');
      setData(payload?.data ?? payload);
      setConfirmDelete(null);
      setFeedback({ tone: 'ok', text: `Сервер «${name}» удалён.` });
    } catch (e) {
      setFeedback({ tone: 'error', text: e instanceof Error ? e.message : 'Не удалось удалить сервер.' });
    } finally {
      setBusy(null);
    }
  };

  const actionError = (server: McpServer): string | null => {
    if (server.status !== 'error' || !server.last_error) return null;
    return server.last_error;
  };

  if (loading && !data) {
    return (
      <div className="flex items-center gap-2 py-16 justify-center text-xs text-[var(--text-muted)]">
        <Loader2 size={16} className="animate-spin" />
        Загрузка MCP-серверов…
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="space-y-3">
        <div role="alert" className="flex items-center gap-2 p-3 rounded-[var(--radius-sm)] border border-[var(--danger)]/40 bg-[var(--danger-quiet)] text-xs text-[var(--danger)]">
          <AlertCircle size={14} />
          <span>{error}</span>
        </div>
        <Button variant="secondary" size="sm" onClick={() => void load()}>
          Повторить
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-[var(--text)]">MCP-серверы</h3>
          <p className="text-xs text-[var(--text-muted)] mt-0.5 max-w-xl">
            Инструменты, которые ядро даёт Нейре: файлы, поиск, базы. Добавление и изменения применяются без
            перезапуска ядра.
          </p>
        </div>
        <div className="flex items-center gap-2 ml-auto shrink-0">
          <IconButton
            aria-label="Обновить статус MCP"
            tooltip="Обновить статус"
            icon={<RefreshCw size={14} className={loading ? 'animate-spin' : ''} />}
            variant="ghost"
            size="sm"
            onClick={() => void load()}
          />
          <Button
            variant="secondary"
            size="sm"
            className="gap-1.5"
            disabled={busy === 'reload'}
            loading={busy === 'reload'}
            onClick={() => void reloadAll()}
          >
            <RefreshCw size={13} />
            Перечитать всё
          </Button>
          <Button variant="primary" size="sm" className="gap-1.5" onClick={startCreate}>
            <Plus size={14} />
            Добавить сервер
          </Button>
        </div>
      </div>

      {feedback && (
        <div
          role={feedback.tone === 'error' ? 'alert' : 'status'}
          className={`flex items-center gap-2 p-3 rounded-[var(--radius-sm)] border text-xs ${
            feedback.tone === 'error'
              ? 'border-[var(--danger)]/40 bg-[var(--danger-quiet)] text-[var(--danger)]'
              : 'border-[var(--border-strong)] bg-[var(--surface-3)] text-[var(--text)]'
          }`}
        >
          {feedback.tone === 'error' ? <AlertCircle size={14} /> : <Check size={14} />}
          <span>{feedback.text}</span>
          <IconButton
            aria-label="Скрыть сообщение"
            icon={<X size={12} />}
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => setFeedback(null)}
          />
        </div>
      )}

      {data && !data.enabled && (
        <div className="flex items-start gap-2 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--surface-3)] p-3 text-xs text-[var(--text-muted)]">
          <ShieldAlert size={14} className="mt-0.5 shrink-0" />
          <span>
            MCP-клиент выключен в конфиге ядра (<code className="font-mono">mcp_client.enabled=false</code>).
            Серверы можно настроить, но подключение и инструменты не заработают, пока его не включат в конфиге.
            Перезапуск отдельного сервера недоступен.
          </span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--text-muted)]">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1">
          <Server size={11} />
          серверов: {servers.length}
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--success)]" />
          подключено: {connectedCount}
        </span>
        {errorCount > 0 && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--danger)]/40 bg-[var(--danger-quiet)] px-2.5 py-1 text-[var(--danger)]">
            <AlertCircle size={11} />
            с ошибкой: {errorCount}
          </span>
        )}
      </div>

      {form && (
        <div className="rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--surface)] p-4 space-y-4">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="text-sm font-semibold text-[var(--text)]">
                {form.mode === 'create' ? 'Новый MCP-сервер' : `Настройка «${form.original}»`}
              </div>
              <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
                {form.transport === 'stdio'
                  ? 'Локальный процесс: команда запуска и аргументы.'
                  : 'Сетевой сервер: HTTP(S)-адрес SSE.'}
              </p>
            </div>
            <IconButton
              aria-label="Закрыть форму MCP"
              icon={<X size={14} />}
              variant="ghost"
              size="sm"
              onClick={closeForm}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="space-y-1 text-[11px] text-[var(--text-muted)]">
              <span className="block font-medium">Имя *</span>
              <input
                value={form.name}
                onChange={(event) => setDraft({ name: event.target.value })}
                disabled={form.mode === 'edit'}
                placeholder="filesystem"
                className="w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-2 text-xs font-mono text-[var(--text)] outline-none focus:border-[var(--accent)] disabled:opacity-60"
              />
              <span className="block text-[10px] text-[var(--text-subtle)]">
                1–64 символа: латиница, цифры, точка, дефис или _.
              </span>
            </label>

            <label className="space-y-1 text-[11px] text-[var(--text-muted)]">
              <span className="block font-medium">Транспорт *</span>
              <select
                value={form.transport}
                onChange={(event) => setDraft({ transport: event.target.value as McpTransport })}
                className="w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-2 text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]"
              >
                <option value="stdio">stdio — локальная команда</option>
                <option value="sse">SSE — HTTP(S)-адрес</option>
              </select>
              <span className="block text-[10px] text-[var(--text-subtle)]">
                Ядро принимает stdio и SSE; для сетевого сервера нужен HTTP(S)-адрес SSE.
              </span>
            </label>
          </div>

          {form.transport === 'stdio' ? (
            <>
              <label className="space-y-1 text-[11px] text-[var(--text-muted)] block">
                <span className="block font-medium">Команда *</span>
                <input
                  value={form.command}
                  onChange={(event) => setDraft({ command: event.target.value })}
                  placeholder="npx"
                  className="w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-2 text-xs font-mono text-[var(--text)] outline-none focus:border-[var(--accent)]"
                />
              </label>
              <label className="space-y-1 text-[11px] text-[var(--text-muted)] block">
                <span className="block font-medium">Аргументы</span>
                <textarea
                  value={form.argsText}
                  onChange={(event) => setDraft({ argsText: event.target.value })}
                  rows={4}
                  placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/data'}
                  className="w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-2 text-xs font-mono text-[var(--text)] outline-none focus:border-[var(--accent)] resize-y"
                />
                <span className="block text-[10px] text-[var(--text-subtle)]">
                  По одному аргументу на строку, до {MAX_MCP_ARGS}.
                </span>
              </label>
              <label className="space-y-1 text-[11px] text-[var(--text-muted)] block">
                <span className="block font-medium">Рабочая папка (необязательно)</span>
                <input
                  value={form.cwd}
                  onChange={(event) => setDraft({ cwd: event.target.value })}
                  placeholder="/data"
                  className="w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-2 text-xs font-mono text-[var(--text)] outline-none focus:border-[var(--accent)]"
                />
              </label>
            </>
          ) : (
            <label className="space-y-1 text-[11px] text-[var(--text-muted)] block">
              <span className="block font-medium">URL *</span>
              <input
                value={form.url}
                onChange={(event) => setDraft({ url: event.target.value })}
                placeholder="https://mcp.example/sse"
                className="w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-2 text-xs font-mono text-[var(--text)] outline-none focus:border-[var(--accent)]"
              />
              <span className="block text-[10px] text-[var(--text-subtle)]">
                Логин и пароль в адресе не поддерживаются. URL с userinfo ядро маскирует.
              </span>
            </label>
          )}

          <label className="inline-flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(event) => setDraft({ enabled: event.target.checked })}
              className="h-3.5 w-3.5 accent-[var(--accent)]"
            />
            Включён: ядро подключает сервер и отдаёт его инструменты Нейре
          </label>

          <div className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] p-3 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-[11px] font-medium text-[var(--text)]">Переменные окружения</div>
              {form.mode === 'edit' && !form.replaceEnv ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setDraft({ replaceEnv: true });
                    if (form.env.length === 0) addEnvRow();
                  }}
                >
                  Изменить переменные
                </Button>
              ) : (
                <div className="flex items-center gap-1.5">
                  <Button variant="ghost" size="sm" className="gap-1" onClick={addEnvRow}>
                    <Plus size={12} />
                    Добавить
                  </Button>
                  {form.mode === 'edit' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        const original = servers.find((server) => server.name === form.original);
                        if (original) resetEnv(original);
                      }}
                    >
                      Отменить замену
                    </Button>
                  )}
                </div>
              )}
            </div>

            {form.mode === 'edit' && !form.replaceEnv ? (
              form.env.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {servers
                    .find((server) => server.name === form.original)
                    ?.env.map((item) => <EnvBadge key={item.name} item={item} />)}
                </div>
              ) : (
                <p className="text-[11px] text-[var(--text-subtle)]">Переменных нет.</p>
              )
            ) : (
              <>
                {form.mode === 'edit' && (
                  <p className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-[10px] leading-relaxed text-[var(--text-muted)]">
                    Ядро не возвращает значения. Чтобы изменить окружение, введите заново все переменные,
                    которые должны остаться; иначе нажмите «Отменить замену».
                  </p>
                )}
                {form.env.length === 0 ? (
                  <p className="text-[11px] text-[var(--text-subtle)]">Переменных пока нет.</p>
                ) : (
                  <div className="space-y-1.5">
                    {form.env.map((row) => (
                      <div key={row.id} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_auto] gap-1.5 items-start">
                        <input
                          value={row.name}
                          onChange={(event) => setEnvRow(row.id, { name: event.target.value })}
                          disabled={row.existing}
                          placeholder="API_KEY"
                          aria-label="Имя переменной"
                          className="w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-[11px] font-mono text-[var(--text)] outline-none focus:border-[var(--accent)] disabled:opacity-60"
                        />
                        <input
                          type="password"
                          autoComplete="new-password"
                          value={row.value}
                          onChange={(event) => setEnvRow(row.id, { value: event.target.value })}
                          placeholder={row.existing ? 'заменить значение' : 'значение'}
                          aria-label={`Значение ${row.name || 'переменной'}`}
                          className="w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-[11px] font-mono text-[var(--text)] outline-none focus:border-[var(--accent)]"
                        />
                        <IconButton
                          aria-label={`Убрать переменную ${row.name || ''}`.trim()}
                          icon={<X size={12} />}
                          variant="ghost"
                          size="sm"
                          className="mt-0.5"
                          onClick={() => removeEnvRow(row.id)}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Button variant="primary" size="sm" disabled={saving} loading={saving} onClick={() => void submit()}>
              {form.mode === 'create' ? 'Добавить сервер' : 'Сохранить'}
            </Button>
            <Button variant="ghost" size="sm" onClick={closeForm}>
              Отмена
            </Button>
          </div>
        </div>
      )}

      {servers.length === 0 ? (
        <div className="rounded-[var(--radius)] border border-dashed border-[var(--border)] px-4 py-10 text-center">
          <Plug size={20} className="mx-auto text-[var(--text-subtle)]" />
          <p className="mt-2 text-sm font-medium text-[var(--text)]">MCP-серверы не подключены</p>
          <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-[var(--text-muted)]">
            MCP даёт Нейре инструменты: работу с файлами, поиск, базы и другие сервисы. Добавьте сервер —
            ядро подключит его без перезапуска. Ошибка подключения не останавливает ядро.
          </p>
          <Button variant="secondary" size="sm" className="mt-3 gap-1.5" onClick={startCreate}>
            <Plus size={13} />
            Добавить сервер
          </Button>
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden md:block rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="border-b border-[var(--border)] text-left text-[10px] uppercase tracking-wider text-[var(--text-subtle)]">
                  <th className="px-3 py-2.5 font-medium">Сервер</th>
                  <th className="px-3 py-2.5 font-medium">Инструменты</th>
                  <th className="px-3 py-2.5 font-medium">Состояние</th>
                  <th className="px-3 py-2.5 font-medium">Проверка</th>
                  <th className="px-3 py-2.5 font-medium text-right">Действия</th>
                </tr>
              </thead>
              <tbody>
                {servers.map((server) => {
                  const meta = STATUS_META[server.status] ?? STATUS_META.disconnected;
                  const lastError = actionError(server);
                  return (
                    <tr key={server.name} className="border-b border-[var(--border)] last:border-0 align-top">
                      <td className="px-3 py-3">
                        <div className="flex items-start gap-2">
                          <span className={`mt-1.5 h-1.5 w-1.5 rounded-full shrink-0 ${meta.dot}`} aria-hidden="true" />
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="font-mono text-[var(--text)] font-medium">{server.name}</span>
                              <span className="rounded border border-[var(--border)] bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">
                                {TRANSPORT_LABEL[server.transport] ?? server.transport}
                              </span>
                              {!server.enabled && (
                                <span className="text-[10px] text-[var(--text-subtle)]">выключен</span>
                              )}
                            </div>
                            <p className="mt-0.5 max-w-[260px] truncate font-mono text-[10px] text-[var(--text-subtle)]" title={server.command || server.url || ''}>
                              {server.command || server.url || '—'}
                            </p>
                            {server.env.length > 0 && (
                              <p className="mt-0.5 text-[10px] text-[var(--text-subtle)]">
                                env: {server.env.map((item) => `${item.name}${item.set ? '' : ' (не задан)'}`).join(', ')}
                              </p>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3 text-[var(--text-muted)] tabular-nums">{server.tools}</td>
                      <td className="px-3 py-3">
                        <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] ${meta.pill}`}>
                          <StatusDot status={server.status} />
                        </span>
                        {lastError && (
                          <div className="mt-1 max-w-[260px]">
                            <p className="text-[10px] leading-relaxed text-[var(--danger)] break-words">{lastError}</p>
                            <p className="mt-0.5 text-[10px] text-[var(--text-subtle)]">
                              Ядро работает; исправьте настройки или переподключите.
                            </p>
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-3 text-[10px] text-[var(--text-subtle)] whitespace-nowrap">
                        {formatChecked(server.checked_at)}
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="secondary"
                            size="sm"
                            className="gap-1"
                            aria-label={`Переподключить ${server.name}`}
                            disabled={busy !== null || !server.enabled || !data?.enabled}
                            loading={busy === `restart:${server.name}`}
                            title={
                              !data?.enabled
                                ? 'MCP выключен в конфиге ядра'
                                : !server.enabled
                                  ? 'Сервер выключен'
                                  : undefined
                            }
                            onClick={() => void restart(server.name)}
                          >
                            <RotateCw size={12} />
                            Переподключить
                          </Button>
                          <IconButton
                            aria-label={`Изменить ${server.name}`}
                            tooltip="Изменить"
                            icon={<Pencil size={13} />}
                            variant="ghost"
                            size="sm"
                            onClick={() => startEdit(server)}
                          />
                          <IconButton
                            aria-label={`Удалить ${server.name}`}
                            tooltip="Удалить"
                            icon={<Trash2 size={13} />}
                            variant="ghost"
                            size="sm"
                            className="text-[var(--text-muted)] hover:text-[var(--danger)]"
                            onClick={() => setConfirmDelete(server.name)}
                          />
                        </div>
                        {confirmDelete === server.name && (
                          <div className="mt-2 rounded-[var(--radius-sm)] border border-[var(--danger)]/40 bg-[var(--danger-quiet)] p-2 text-right">
                            <p className="text-[10px] text-[var(--danger)]">
                              Удалить «{server.name}» вместе с переменными окружения?
                            </p>
                            <div className="mt-1.5 flex justify-end gap-1.5">
                              <Button
                                variant="danger"
                                size="sm"
                                aria-label={`Подтвердить удаление ${server.name}`}
                                disabled={busy !== null}
                                loading={busy === `delete:${server.name}`}
                                onClick={() => void remove(server.name)}
                              >
                                Удалить
                              </Button>
                              <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(null)}>
                                Отмена
                              </Button>
                            </div>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden space-y-2.5">
            {servers.map((server) => {
              const meta = STATUS_META[server.status] ?? STATUS_META.disconnected;
              const lastError = actionError(server);
              return (
                <div key={server.name} className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} aria-hidden="true" />
                        <span className="font-mono text-sm font-medium text-[var(--text)]">{server.name}</span>
                        <span className="rounded border border-[var(--border)] bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">
                          {TRANSPORT_LABEL[server.transport] ?? server.transport}
                        </span>
                      </div>
                      <p className="mt-1 truncate font-mono text-[10px] text-[var(--text-subtle)]" title={server.command || server.url || ''}>
                        {server.command || server.url || '—'}
                      </p>
                    </div>
                    <span className={`shrink-0 inline-flex rounded-full border px-2 py-0.5 text-[10px] ${meta.pill}`}>
                      <StatusDot status={server.status} />
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-[var(--text-subtle)]">
                    <span>инструментов: {server.tools}</span>
                    <span>проверка: {formatChecked(server.checked_at)}</span>
                    {!server.enabled && <span>выключен</span>}
                  </div>

                  {server.env.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {server.env.map((item) => <EnvBadge key={item.name} item={item} />)}
                    </div>
                  )}

                  {lastError && (
                    <div className="rounded-[var(--radius-sm)] border border-[var(--danger)]/40 bg-[var(--danger-quiet)] p-2">
                      <p className="text-[10px] leading-relaxed text-[var(--danger)] break-words">{lastError}</p>
                      <p className="mt-0.5 text-[10px] text-[var(--text-subtle)]">
                        Ядро работает; исправьте настройки или переподключите.
                      </p>
                    </div>
                  )}

                  {confirmDelete === server.name ? (
                    <div className="rounded-[var(--radius-sm)] border border-[var(--danger)]/40 bg-[var(--danger-quiet)] p-2 space-y-1.5">
                      <p className="text-[10px] text-[var(--danger)]">
                        Удалить «{server.name}» вместе с переменными окружения?
                      </p>
                      <div className="flex gap-1.5">
                        <Button
                          variant="danger"
                          size="sm"
                          aria-label={`Подтвердить удаление ${server.name}`}
                          disabled={busy !== null}
                          loading={busy === `delete:${server.name}`}
                          onClick={() => void remove(server.name)}
                        >
                          Удалить
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(null)}>
                          Отмена
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Button
                        variant="secondary"
                        size="sm"
                        className="gap-1"
                        aria-label={`Переподключить ${server.name}`}
                        disabled={busy !== null || !server.enabled || !data?.enabled}
                        loading={busy === `restart:${server.name}`}
                        onClick={() => void restart(server.name)}
                      >
                        <RotateCw size={12} />
                        Переподключить
                      </Button>
                      <Button variant="ghost" size="sm" className="gap-1" onClick={() => startEdit(server)}>
                        <Pencil size={12} />
                        Изменить
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="gap-1 text-[var(--text-muted)] hover:text-[var(--danger)] ml-auto"
                        aria-label={`Удалить ${server.name}`}
                        onClick={() => setConfirmDelete(server.name)}
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
        </>
      )}

      <p className="text-[11px] text-[var(--text-subtle)]">
        Изменения сохраняются в конфиг ядра и применяются сразу. Ошибка одного MCP-сервера не останавливает
        ядро; статус и причина видны в таблице. Автообновления нет — статус обновляется кнопкой.
      </p>
    </div>
  );
}
