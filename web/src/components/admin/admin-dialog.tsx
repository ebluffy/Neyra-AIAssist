'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  Ban,
  Check,
  ChevronRight,
  Copy,
  Cpu,
  Database,
  ExternalLink,
  FileText,
  Folder,
  Key,
  LayoutDashboard,
  Plug,
  Plus,
  RefreshCw,
  RotateCw,
  Search,
  Server,
  Shield,
  UserCheck,
  Users,
  Workflow,
  X,
} from 'lucide-react';
import { Button, IconButton } from '../ui';

export type Tone = 'ok' | 'warn' | 'error' | 'muted';

const toneClass: Record<Tone, string> = {
  ok: 'border-[var(--border-strong)] bg-[var(--surface-3)] text-[var(--text)]',
  warn: 'border-[var(--border-strong)] bg-[var(--surface-2)] text-[var(--text-muted)]',
  error: 'border-[var(--danger)] bg-[var(--danger-quiet)] text-[var(--danger)]',
  muted: 'border-[var(--border)] bg-transparent text-[var(--text-subtle)]',
};

export function StatusPill({ tone = 'muted', children }: { tone?: Tone; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${toneClass[tone]}`}>
      {children}
    </span>
  );
}
import { playButtonClickSound, playModalCloseSound, playModalOpenSound } from '../../lib/ui-sounds';
import { ProvidersSection } from './providers-section';
import { AdminPageSection } from './admin-pages';

export type AdminSection =
  | 'overview'
  | 'models'
  | 'providers'
  | 'integrations'
  | 'access'
  | 'system'
  | 'logs'
  | 'memory'
  | 'files'
  | 'prompts';

const SECTION_HINT: Record<AdminSection, string> = {
  overview: 'Состояние ядра, модели и быстрые переходы',
  models: 'Провайдер и модель для каждого лейна',
  providers: 'Любой OpenAI-совместимый шлюз и его ключ',
  integrations: 'Инструменты ядра, Discord и служебные подключения',
  access: 'Пользователи, роли, приглашения и режим регистрации',
  system: 'Сервисы, диск, резервные копии и перезапуск',
  logs: 'Действия админки и операции ядра',
  memory: 'Люди и статистика долгой памяти',
  files: 'Вложения, которые принимает Neyra',
  prompts: 'Персона и системные инструкции ядра',
};

export interface AdminDialogProps {
  open: boolean;
  onClose: () => void;
  initialSection?: AdminSection;
  user?: { id: string; name?: string | null; email?: string | null; role?: string | null } | null;
}

export function AdminDialog({
  open,
  onClose,
  initialSection = 'overview',
  user,
}: AdminDialogProps) {
  const [activeSection, setActiveSection] = useState<AdminSection>(initialSection);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const mobileNavRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  // Sync initial section when opening
  useEffect(() => {
    if (open) {
      setActiveSection(initialSection);
    }
  }, [open, initialSection]);

  // Audio synthesis and body scroll lock
  useEffect(() => {
    if (open) {
      previousFocusRef.current = document.activeElement as HTMLElement | null;
      playModalOpenSound();
      const originalOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';

      // Focus the dialog itself: screen readers announce its title, and the
      // close button does not flash its tooltip on touch devices.
      const timer = setTimeout(() => {
        dialogRef.current?.focus();
      }, 50);

      return () => {
        clearTimeout(timer);
        document.body.style.overflow = originalOverflow;
      };
    }
  }, [open]);

  // Keep the active tab of the horizontal mobile navigation in view
  useEffect(() => {
    if (!open) return;
    const nav = mobileNavRef.current;
    const active = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (active && typeof active.scrollIntoView === 'function') {
      active.scrollIntoView({ block: 'nearest', inline: 'center' });
    }
  }, [open, activeSection]);

  const handleClose = useCallback(() => {
    playModalCloseSound();
    onClose();
    // Restore focus
    setTimeout(() => {
      previousFocusRef.current?.focus();
    }, 50);
  }, [onClose]);

  // Focus trap & Escape key
  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        handleClose();
        return;
      }

      if (event.key === 'Tab') {
        if (!dialogRef.current) return;
        const focusables = Array.from(
          dialogRef.current.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
          )
        ).filter((el) => el.getClientRects().length > 0);

        if (!focusables.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];

        const active = document.activeElement;
        const inside = active instanceof Node && dialogRef.current.contains(active);

        if (event.shiftKey && (active === first || !inside || active === dialogRef.current)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && active === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, handleClose]);

  if (!open) return null;

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-0 lg:p-4 animate-in fade-in duration-150"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          handleClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-dialog-title"
        tabIndex={-1}
        className="relative w-full h-full lg:h-[86vh] lg:max-h-[860px] lg:max-w-[1040px] bg-[var(--surface-2)] border border-[var(--border-strong)] lg:rounded-[var(--radius)] shadow-panel flex flex-col overflow-hidden text-[var(--text)] outline-none"
      >
        {/* Header */}
        <header className="flex items-center justify-between px-4 sm:px-6 py-3.5 border-b border-[var(--border)] bg-[var(--surface)] shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="flex items-center justify-center w-7 h-7 rounded-[var(--radius-sm)] bg-[var(--surface-3)] border border-[var(--border)] text-[var(--text)]">
              <Shield size={16} />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 id="admin-dialog-title" className="text-sm font-semibold tracking-tight text-[var(--text)] truncate">
                  Админ-панель
                </h2>
                <span className="text-[10px] uppercase font-mono tracking-wider px-1.5 py-0.5 rounded border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-subtle)] shrink-0">
                  {user?.role || 'admin'}
                </span>
              </div>
              <p className="text-[11px] text-[var(--text-muted)] truncate hidden sm:block">
                {SECTION_HINT[activeSection]}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <IconButton
              aria-label="Закрыть панель администратора"
              tooltip="Закрыть (Esc)"
              icon={<X size={16} />}
              variant="ghost"
              size="sm"
              onClick={handleClose}
            />
          </div>
        </header>

        {/* Mobile Navigation Tabs (Horizontal Scroll) */}
        <div
          ref={mobileNavRef}
          className="lg:hidden flex items-center gap-1 overflow-x-auto p-2 border-b border-[var(--border)] bg-[var(--surface)] shrink-0 select-none"
        >
          <NavButton
            active={activeSection === 'overview'}
            icon={<LayoutDashboard size={14} />}
            label="Обзор"
            onClick={() => setActiveSection('overview')}
          />
          <NavButton
            active={activeSection === 'models'}
            icon={<Cpu size={14} />}
            label="Модели"
            onClick={() => setActiveSection('models')}
          />
          <NavButton
            active={activeSection === 'providers'}
            icon={<Key size={14} />}
            label="Провайдеры"
            onClick={() => setActiveSection('providers')}
          />
          <NavButton
            active={activeSection === 'integrations'}
            icon={<Workflow size={14} />}
            label="Интеграции"
            onClick={() => setActiveSection('integrations')}
          />
          <NavButton
            active={activeSection === 'access'}
            icon={<Users size={14} />}
            label="Доступ"
            onClick={() => setActiveSection('access')}
          />
          <NavButton
            active={activeSection === 'system'}
            icon={<Server size={14} />}
            label="Система"
            onClick={() => setActiveSection('system')}
          />
          <NavButton
            active={activeSection === 'logs'}
            icon={<FileText size={14} />}
            label="Журналы"
            onClick={() => setActiveSection('logs')}
          />
          <NavButton
            active={activeSection === 'memory'}
            icon={<Database size={14} />}
            label="Память"
            onClick={() => setActiveSection('memory')}
          />
          <NavButton
            active={activeSection === 'files'}
            icon={<Folder size={14} />}
            label="Файлы"
            onClick={() => setActiveSection('files')}
          />
          <NavButton
            active={activeSection === 'prompts'}
            icon={<Key size={14} />}
            label="Промпты"
            onClick={() => setActiveSection('prompts')}
          />
        </div>

        {/* Main Body */}
        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* Desktop Left Sidebar (220px) */}
          <aside
            aria-label="Разделы админки"
            className="hidden lg:flex flex-col justify-between w-[220px] shrink-0 border-r border-[var(--border)] bg-[var(--surface)] p-3 overflow-y-auto select-none"
          >
            <div className="space-y-1">
              <p className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-subtle)]">
                Управление
              </p>
              <NavButton
                active={activeSection === 'overview'}
                icon={<LayoutDashboard size={15} />}
                label="Обзор"
                onClick={() => setActiveSection('overview')}
              />
              <NavButton
                active={activeSection === 'models'}
                icon={<Cpu size={15} />}
                label="Модели"
                onClick={() => setActiveSection('models')}
              />
              <NavButton
                active={activeSection === 'providers'}
                icon={<Key size={15} />}
                label="Провайдеры"
                onClick={() => setActiveSection('providers')}
              />
              <NavButton
                active={activeSection === 'integrations'}
                icon={<Workflow size={15} />}
                label="Интеграции"
                onClick={() => setActiveSection('integrations')}
              />
              <NavButton
                active={activeSection === 'access'}
                icon={<Users size={15} />}
                label="Доступ"
                onClick={() => setActiveSection('access')}
              />
              <NavButton
                active={activeSection === 'system'}
                icon={<Server size={15} />}
                label="Система"
                onClick={() => setActiveSection('system')}
              />

              <div className="pt-3 pb-1 border-t border-[var(--border)] mt-3 space-y-1">
                <p className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-subtle)]">
                  Данные
                </p>
                <NavButton
                  active={activeSection === 'logs'}
                  icon={<FileText size={15} />}
                  label="Журналы"
                  onClick={() => setActiveSection('logs')}
                />
                <NavButton
                  active={activeSection === 'memory'}
                  icon={<Database size={15} />}
                  label="Память"
                  onClick={() => setActiveSection('memory')}
                />
                <NavButton
                  active={activeSection === 'files'}
                  icon={<Folder size={15} />}
                  label="Файлы"
                  onClick={() => setActiveSection('files')}
                />
                <NavButton
                  active={activeSection === 'prompts'}
                  icon={<Key size={15} />}
                  label="Промпты"
                  onClick={() => setActiveSection('prompts')}
                />
              </div>
            </div>

            <div className="pt-3 border-t border-[var(--border)] px-2 text-[11px] text-[var(--text-subtle)] flex items-center justify-between">
              <span>Neyra Admin</span>
              <span className="font-mono text-[10px]">v1</span>
            </div>
          </aside>

          {/* Right Content Area */}
          <main className="flex-1 min-w-0 overflow-y-auto p-4 sm:p-6 bg-[var(--surface-2)]">
            {activeSection === 'overview' && <OverviewSection onNavigate={setActiveSection} />}
            {activeSection === 'models' && <ModelsSection />}
            {activeSection === 'providers' && <ProvidersSection />}
            {activeSection === 'integrations' && <IntegrationsSection onOpenProviders={() => setActiveSection('providers')} />}
            {activeSection === 'access' && <AccessSection />}
            {activeSection === 'system' && <SystemSection />}
            {activeSection === 'logs' && <AdminPageSection kind="logs" />}
            {activeSection === 'memory' && <AdminPageSection kind="memory" />}
            {activeSection === 'files' && <AdminPageSection kind="files" />}
            {activeSection === 'prompts' && <AdminPageSection kind="prompts" />}
          </main>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helper Nav Button
// ---------------------------------------------------------------------------

function NavButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={active ? 'page' : undefined}
      onClick={() => {
        playButtonClickSound();
        onClick();
      }}
      className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-[var(--radius-sm)] text-xs font-medium transition-colors text-left cursor-pointer whitespace-nowrap ${
        active
          ? 'bg-[var(--accent)] text-[var(--accent-ink)] shadow-sm'
          : 'text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-3)]'
      }`}
    >
      <span className="shrink-0">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  );
}

function SidebarPageLink({
  href,
  icon,
  label,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <Link
      href={href}
      className="flex items-center justify-between px-2.5 py-1.5 rounded-[var(--radius-sm)] text-xs text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-3)] transition-colors group"
    >
      <div className="flex items-center gap-2 truncate">
        <span className="shrink-0 text-[var(--text-subtle)] group-hover:text-[var(--text)]">{icon}</span>
        <span className="truncate">{label}</span>
      </div>
      <ExternalLink size={11} className="shrink-0 text-[var(--text-subtle)] opacity-70 group-hover:opacity-100" />
    </Link>
  );
}

// ---------------------------------------------------------------------------
// SECTION 1: OVERVIEW
// ---------------------------------------------------------------------------

interface OverviewData {
  users?: { total: number; admins: number; banned: number };
  invites?: { total: number; active: number; used: number };
  audit24h?: number;
  core?: { state: string; message: string | null };
}

interface SystemData {
  site?: {
    version?: string | null;
    commit?: string | null;
    uptimeSeconds?: number;
    disk?: { freeBytes: number; totalBytes: number };
    backups?: { configured: boolean; items: Array<string | { name: string; size?: number; modifiedAt?: string }> };
  };
  core?: {
    health?: { state: string; message?: string | null; data?: { ok?: boolean; version?: string; uptime_seconds?: number } };
    ready?: { state: string; message?: string | null; data?: { ok?: boolean; checks?: Array<{ name?: string; ok?: boolean; ms?: number }> } };
  };
}

function OverviewSection({ onNavigate }: { onNavigate: (section: AdminSection) => void }) {
  const [data, setData] = useState<{ overview: OverviewData | null; system: SystemData | null }>({
    overview: null,
    system: null,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [overviewRes, systemRes] = await Promise.all([
        fetch('/api/admin/overview'),
        fetch('/api/admin/system'),
      ]);
      const overviewJson = await overviewRes.json().catch(() => null);
      const systemJson = await systemRes.json().catch(() => null);

      if (!overviewRes.ok && !systemRes.ok) {
        throw new Error(overviewJson?.message || systemJson?.message || 'Не удалось загрузить сводку админки.');
      }

      setData({
        overview: overviewJson?.data || null,
        system: systemJson?.data || null,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки данных.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  if (loading) {
    return <LoadingState message="Загрузка сводки админ-панели…" />;
  }

  if (error && !data.overview && !data.system) {
    return <ErrorState message={error} onRetry={loadData} />;
  }

  const { overview, system } = data;
  const coreHealth = system?.core?.health?.data;
  const coreState = system?.core?.health?.state || overview?.core?.state;
  const isCoreOk = coreState === 'ok' && coreHealth?.ok !== false;

  const coreTone: Tone = !isCoreOk ? (coreState === 'ok' ? 'warn' : 'error') : 'ok';
  const coreLabel = !isCoreOk ? (coreState === 'ok' ? 'деградировало' : 'недоступно') : 'в норме';

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold text-[var(--text)]">Обзор состояния</h3>
        <p className="text-xs text-[var(--text-muted)] mt-0.5">
          Сводка состояния сайта, ядра Нейры и ключевых ресурсов
        </p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatTile
          label="Пользователи"
          value={overview?.users?.total ?? '—'}
          hint={overview?.users ? `админов: ${overview.users.admins} · бан: ${overview.users.banned}` : '—'}
          onClick={() => onNavigate('access')}
        />
        <StatTile
          label="Активные инвайты"
          value={overview?.invites?.active ?? '—'}
          hint={overview?.invites ? `использовано: ${overview.invites.used} из ${overview.invites.total}` : '—'}
          onClick={() => onNavigate('access')}
        />
        <StatTile
          label="Действия за сутки"
          value={overview?.audit24h ?? '—'}
          hint="записи в аудите админки"
        />
        <div className="p-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] flex flex-col justify-between">
          <div>
            <p className="text-[11px] text-[var(--text-muted)]">Ядро Нейры</p>
            <div className="mt-1.5">
              <StatusPill tone={coreTone}>{coreLabel}</StatusPill>
            </div>
          </div>
          <p className="text-[10px] text-[var(--text-subtle)] mt-2 truncate">
            {coreHealth?.version ? `v${coreHealth.version}` : 'ядро'} · {formatSeconds(coreHealth?.uptime_seconds)}
          </p>
        </div>
      </div>

      {/* Cards: System & Core details */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Core Readiness */}
        <div className="p-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] space-y-3">
          <div className="flex items-center justify-between border-b border-[var(--border)] pb-2.5">
            <h4 className="text-xs font-semibold text-[var(--text)] flex items-center gap-1.5">
              <Activity size={14} className="text-[var(--text-muted)]" />
              <span>Готовность ядра (/v1/health/ready)</span>
            </h4>
            <StatusPill tone={system?.core?.ready?.data?.ok ? 'ok' : 'warn'}>
              {system?.core?.ready?.data?.ok ? 'готов' : 'проверка'}
            </StatusPill>
          </div>

          {Array.isArray(system?.core?.ready?.data?.checks) && system.core.ready.data.checks.length > 0 ? (
            <ul className="space-y-1.5 text-xs">
              {system.core.ready.data.checks.map((check, idx) => (
                <li key={idx} className="flex items-center justify-between gap-2 py-1 border-b border-[var(--border)] last:border-0">
                  <span className="text-[var(--text)]">{check.name || 'проверка'}</span>
                  <div className="flex items-center gap-2">
                    {typeof check.ms === 'number' && (
                      <span className="text-[10px] text-[var(--text-subtle)] font-mono">{check.ms} мс</span>
                    )}
                    <StatusPill tone={check.ok ? 'ok' : 'error'}>{check.ok ? 'ок' : 'сбой'}</StatusPill>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-[var(--text-muted)]">
              {system?.core?.ready?.message || 'Информация о проверках ядра пока недоступна.'}
            </p>
          )}
        </div>

        {/* Site & Storage */}
        <div className="p-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] space-y-3">
          <div className="flex items-center justify-between border-b border-[var(--border)] pb-2.5">
            <h4 className="text-xs font-semibold text-[var(--text)] flex items-center gap-1.5">
              <Server size={14} className="text-[var(--text-muted)]" />
              <span>Параметры окружения</span>
            </h4>
            <span className="text-[10px] text-[var(--text-subtle)] font-mono">
              uptime: {formatSeconds(system?.site?.uptimeSeconds)}
            </span>
          </div>

          <div className="space-y-2 text-xs">
            <div className="flex justify-between py-1 border-b border-[var(--border)]">
              <span className="text-[var(--text-muted)]">Версия сайта</span>
              <span className="font-mono text-[var(--text)]">{system?.site?.version || 'демо'}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-[var(--border)]">
              <span className="text-[var(--text-muted)]">Коммит</span>
              <span className="font-mono text-[var(--text)]">
                {system?.site?.commit ? system.site.commit.slice(0, 8) : 'локальный'}
              </span>
            </div>
            <div className="flex justify-between py-1 border-b border-[var(--border)]">
              <span className="text-[var(--text-muted)]">Свободно на диске</span>
              <span className="font-mono text-[var(--text)]">
                {system?.site?.disk ? formatBytes(system.site.disk.freeBytes) : '—'}
              </span>
            </div>
            <div className="flex justify-between py-1">
              <span className="text-[var(--text-muted)]">Резервные копии</span>
              <span className="font-mono text-[var(--text)]">
                {system?.site?.backups ? `${system.site.backups.items.length} файлов` : '—'}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Quick Links banner */}
      <div className="p-3.5 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-3)] flex flex-wrap items-center justify-between gap-3 text-xs">
        <span className="text-[var(--text-muted)]">
          Нужно скорректировать параметры моделей или проверить интеграции?
        </span>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => onNavigate('models')}>
            Модели
          </Button>
          <Button variant="secondary" size="sm" onClick={() => onNavigate('integrations')}>
            Интеграции
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SECTION 2: MODELS
// ---------------------------------------------------------------------------

interface LaneConfig {
  provider: string;
  model: string;
  resolved_model?: string;
  temperature: number | null;
  context_window: number | null;
  max_tokens: number | null;
  enabled?: boolean | null;
  thinking?: boolean | null;
  thinking_effort?: string | null;
}

interface ConfigSnapshot {
  lanes: Record<string, LaneConfig>;
  providers: string[];
  mcp?: { enabled: boolean; servers: Array<{ name: string; enabled: boolean }> };
  secrets?: Record<string, 'set' | 'missing'>;
}

const laneRussianNames: Record<string, string> = {
  talk: 'Разговор (интерфейс чата)',
  brain: 'Рассуждение (инструменты и логика)',
  memory: 'Память (обобщение диалогов)',
  vision: 'Зрение (анализ изображений)',
};

function ModelsSection() {
  const [config, setConfig] = useState<ConfigSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [laneForms, setLaneForms] = useState<
    Record<
      string,
      {
        provider: string;
        model: string;
        temperature: string;
        context_window: string;
        max_tokens: string;
        thinking_effort: string;
      }
    >
  >({});
  const [savingLane, setSavingLane] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Record<string, { tone: 'ok' | 'error' | 'warn'; text: string }>>({});

  const loadConfig = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/config');
      const json = await res.json().catch(() => null);
      if (!res.ok || json?.ok === false) {
        throw new Error(json?.message || 'Ядро не отдало настройки моделей.');
      }
      const data: ConfigSnapshot = json.data?.config || json.config || json.data;
      setConfig(data);

      const initialForms: Record<string, any> = {};
      if (data?.lanes) {
        for (const [lane, val] of Object.entries(data.lanes)) {
          initialForms[lane] = {
            provider: val.provider || '',
            model: val.model || '',
            temperature: val.temperature !== null && val.temperature !== undefined ? String(val.temperature) : '',
            context_window: val.context_window !== null && val.context_window !== undefined ? String(val.context_window) : '',
            max_tokens: val.max_tokens !== null && val.max_tokens !== undefined ? String(val.max_tokens) : '',
            thinking_effort:
              val.thinking_effort || (val.thinking === false ? 'off' : 'default'),
          };
        }
      }
      setLaneForms(initialForms);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки конфига.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  const handleSaveLane = async (laneKey: string) => {
    const form = laneForms[laneKey];
    if (!form || savingLane) return;

    const updates: Record<string, string | number | boolean> = {
      [`llm.${laneKey}_model.provider`]: form.provider,
      [`llm.${laneKey}_model.model`]: form.model.trim(),
      [`llm.${laneKey}_model.thinking_effort`]: form.thinking_effort,
    };

    const maxTokensField = laneKey === 'talk' ? 'reply_max_tokens' : 'max_tokens';
    const numFields: Array<[string, string]> = [
      ['temperature', form.temperature],
      ['context_window', form.context_window],
      [maxTokensField, form.max_tokens],
    ];

    for (const [fieldName, rawVal] of numFields) {
      if (!rawVal.trim()) continue;
      const parsed = Number(rawVal);
      if (!Number.isFinite(parsed)) {
        setFeedback((prev) => ({
          ...prev,
          [laneKey]: { tone: 'error', text: `${fieldName}: ожидается числовое значение.` },
        }));
        return;
      }
      updates[`llm.${laneKey}_model.${fieldName}`] = parsed;
    }

    setSavingLane(laneKey);
    setFeedback((prev) => ({ ...prev, [laneKey]: { tone: 'ok', text: '' } }));

    try {
      const res = await fetch('/api/admin/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates }),
      });
      const json = await res.json().catch(() => null);

      if (!res.ok || json?.ok === false) {
        throw new Error(json?.message || 'Ядро не приняло настройки лейна.');
      }

      const restart = Boolean(json?.data?.requires_restart || json?.requires_restart);
      setFeedback((prev) => ({
        ...prev,
        [laneKey]: restart
          ? { tone: 'warn', text: 'Сохранено. Изменение применится после перезапуска ядра.' }
          : { tone: 'ok', text: 'Сохранено и применено.' },
      }));
    } catch (err) {
      setFeedback((prev) => ({
        ...prev,
        [laneKey]: { tone: 'error', text: err instanceof Error ? err.message : 'Не удалось сохранить.' },
      }));
    } finally {
      setSavingLane(null);
    }
  };

  if (loading) {
    return <LoadingState message="Загрузка настроек моделей…" />;
  }

  if (error && !config) {
    return <ErrorState message={error} onRetry={loadConfig} />;
  }

  const providers = config?.providers && config.providers.length > 0
    ? config.providers
    : ['openai', 'openrouter', 'aihope', 'anthropic'];

  const lanes = config?.lanes || {
    talk: { provider: 'openai', model: 'gpt-4o', resolved_model: 'gpt-4o', temperature: 0.7, context_window: 128000, max_tokens: 4096, enabled: true },
    brain: { provider: 'openai', model: 'o1-mini', resolved_model: 'o1-mini', temperature: 1.0, context_window: 128000, max_tokens: 8192, enabled: true },
    memory: { provider: 'openai', model: 'gpt-4o-mini', resolved_model: 'gpt-4o-mini', temperature: 0.2, context_window: 128000, max_tokens: 2048, enabled: true },
    vision: { provider: 'openai', model: 'gpt-4o', resolved_model: 'gpt-4o', temperature: 0.5, context_window: 128000, max_tokens: 4096, enabled: true },
  };

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold text-[var(--text)]">Модели по лейнам</h3>
        <p className="text-xs text-[var(--text-muted)] mt-0.5">
          Раздельная настройка провайдера, модели и лимитов токенов для каждой подсистемы ядра
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {Object.entries(lanes).map(([laneKey, laneConfig]) => {
          const form = laneForms[laneKey] || {
            provider: laneConfig.provider || '',
            model: laneConfig.model || '',
            temperature: String(laneConfig.temperature ?? ''),
            context_window: String(laneConfig.context_window ?? ''),
            max_tokens: String(laneConfig.max_tokens ?? ''),
          };
          const msg = feedback[laneKey];
          const isPending = savingLane === laneKey;

          return (
            <div
              key={laneKey}
              className="p-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] space-y-3 flex flex-col justify-between"
            >
              <div className="space-y-3">
                <div className="flex items-center justify-between border-b border-[var(--border)] pb-2">
                  <div>
                    <h4 className="text-xs font-semibold text-[var(--text)]">
                      {laneRussianNames[laneKey] || laneKey}
                    </h4>
                    <span className="text-[10px] text-[var(--text-subtle)] font-mono">лейн: {laneKey}</span>
                  </div>
                  {laneConfig.resolved_model && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-muted)] font-mono">
                      {laneConfig.resolved_model}
                    </span>
                  )}
                </div>

                {/* Form fields */}
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="col-span-1 space-y-1">
                    <label className="text-[11px] text-[var(--text-muted)] block">Провайдер</label>
                    <select
                      value={form.provider}
                      onChange={(e) =>
                        setLaneForms((prev) => ({
                          ...prev,
                          [laneKey]: { ...form, provider: e.target.value },
                        }))
                      }
                      className="w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1.5 text-xs text-[var(--text)] focus:border-[var(--accent)] outline-none"
                    >
                      {providers.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="col-span-1 space-y-1">
                    <label className="text-[11px] text-[var(--text-muted)] block">Модель</label>
                    <input
                      type="text"
                      value={form.model}
                      placeholder="e.g. gpt-4o"
                      onChange={(e) =>
                        setLaneForms((prev) => ({
                          ...prev,
                          [laneKey]: { ...form, model: e.target.value },
                        }))
                      }
                      className="w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1.5 text-xs text-[var(--text)] focus:border-[var(--accent)] outline-none font-mono"
                    />
                  </div>

                  <div className="col-span-1 space-y-1">
                    <label className="text-[11px] text-[var(--text-muted)] block">Температура</label>
                    <input
                      type="text"
                      value={form.temperature}
                      placeholder="0.7"
                      onChange={(e) =>
                        setLaneForms((prev) => ({
                          ...prev,
                          [laneKey]: { ...form, temperature: e.target.value },
                        }))
                      }
                      className="w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1.5 text-xs text-[var(--text)] focus:border-[var(--accent)] outline-none font-mono"
                    />
                  </div>

                  <div className="col-span-1 space-y-1">
                    <label className="text-[11px] text-[var(--text-muted)] block">Макс. токенов</label>
                    <input
                      type="text"
                      value={form.max_tokens}
                      placeholder="4096"
                      onChange={(e) =>
                        setLaneForms((prev) => ({
                          ...prev,
                          [laneKey]: { ...form, max_tokens: e.target.value },
                        }))
                      }
                      className="w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1.5 text-xs text-[var(--text)] focus:border-[var(--accent)] outline-none font-mono"
                    />
                  </div>
                </div>
              </div>

              <div className="pt-2 border-t border-[var(--border)] space-y-1">
                <label
                  htmlFor={`thinking-effort-${laneKey}`}
                  className="text-[11px] font-medium text-[var(--text)] block"
                >
                  Рассуждение (think)
                </label>
                <select
                  id={`thinking-effort-${laneKey}`}
                  value={form.thinking_effort}
                  onChange={(e) =>
                    setLaneForms((prev) => ({
                      ...prev,
                      [laneKey]: { ...form, thinking_effort: e.target.value },
                    }))
                  }
                  className="w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1.5 text-xs text-[var(--text)] focus:border-[var(--accent)] outline-none"
                >
                  <option value="default">Default — как в модели</option>
                  <option value="off">Off — без рассуждения, самый быстрый</option>
                  <option value="low">Low — короткое рассуждение</option>
                  <option value="medium">Medium — среднее</option>
                  <option value="high">High — долгое</option>
                  <option value="max">Max — без ограничения</option>
                </select>
                <p className="text-[10px] text-[var(--text-subtle)] leading-relaxed">
                  Для локальных reasoning-моделей Off обычно в 5–20 раз быстрее; High/Max — дольше, но глубже.
                </p>
              </div>

              <div className="pt-2 border-t border-[var(--border)] space-y-2">
                {msg?.text && (
                  <p
                    role={msg.tone === 'error' ? 'alert' : 'status'}
                    className={`text-[11px] p-1.5 rounded-[var(--radius-sm)] ${
                      msg.tone === 'error'
                        ? 'bg-[var(--danger-quiet)] text-[var(--danger)] border border-[var(--danger)]/30'
                        : msg.tone === 'warn'
                        ? 'bg-[var(--surface-3)] text-[var(--text-muted)] border border-[var(--border)]'
                        : 'bg-[var(--surface-3)] text-[var(--text)] border border-[var(--border-strong)]'
                    }`}
                  >
                    {msg.text}
                  </p>
                )}

                <div className="flex justify-end">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={isPending}
                    loading={isPending}
                    onClick={() => handleSaveLane(laneKey)}
                  >
                    {isPending ? 'Сохранение…' : 'Сохранить лейн'}
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SECTION 3: INTEGRATIONS
// ---------------------------------------------------------------------------

interface IntegrationsData {
  discord?: { configured: boolean; note?: string };
  providers?: { state: string; names?: string[]; message?: string | null };
  mcp?: { state: string; message?: string | null };
}

function IntegrationsSection({ onOpenProviders }: { onOpenProviders?: () => void }) {
  const [integrations, setIntegrations] = useState<IntegrationsData | null>(null);
  const [config, setConfig] = useState<ConfigSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [intRes, cfgRes] = await Promise.all([
        fetch('/api/admin/integrations'),
        fetch('/api/admin/config'),
      ]);
      const intJson = await intRes.json().catch(() => null);
      const cfgJson = await cfgRes.json().catch(() => null);

      if (!intRes.ok && !cfgRes.ok) {
        throw new Error(intJson?.message || cfgJson?.message || 'Не удалось загрузить данные интеграций.');
      }

      setIntegrations(intJson?.data || intJson || null);
      const cfgData = cfgJson?.data?.config || cfgJson?.config || null;
      setConfig(cfgData);

    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки интеграций.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);


  if (loading) {
    return <LoadingState message="Загрузка состояния интеграций…" />;
  }

  if (error && !integrations && !config) {
    return <ErrorState message={error} onRetry={loadAll} />;
  }

  const activeProviders = integrations?.providers?.names || config?.providers || [];
  const secrets = config?.secrets || {
    OPENAI_API_KEY: 'set',
    OPENROUTER_API_KEY: 'set',
    AIHOPE_API_KEY: 'missing',
  };

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold text-[var(--text)]">Интеграции и подключения</h3>
        <p className="text-xs text-[var(--text-muted)] mt-0.5">
          Внешние провайдеры нейросетей, инструменты MCP и канал авторизации Discord
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* LLM Providers */}
        <div className="p-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] space-y-3">
          <div className="flex items-center justify-between border-b border-[var(--border)] pb-2.5">
            <h4 className="text-xs font-semibold text-[var(--text)] flex items-center gap-1.5">
              <Cpu size={14} className="text-[var(--text-muted)]" />
              <span>Провайдеры моделей</span>
            </h4>
            <StatusPill tone={activeProviders.length > 0 ? 'ok' : 'warn'}>
              {activeProviders.length} в конфиге
            </StatusPill>
          </div>

          <div className="space-y-2">
            <p className="text-xs text-[var(--text-muted)]">Провайдеры в конфиге ядра:</p>
            <div className="flex flex-wrap gap-1.5">
              {activeProviders.length > 0 ? (
                activeProviders.map((name) => (
                  <StatusPill key={name} tone="ok">
                    {name}
                  </StatusPill>
                ))
              ) : (
                <span className="text-xs text-[var(--text-subtle)]">Нет активных провайдеров</span>
              )}
            </div>
          </div>

          <div className="pt-2 border-t border-[var(--border)] space-y-2">
            <p className="text-[11px] font-medium text-[var(--text)]">Адреса и ключи</p>
            <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
              Base URL и API-ключи задаются в разделе «Провайдеры»: там же пресеты и проверка, открыт ли шлюз без ключа.
            </p>
            {onOpenProviders && (
              <Button variant="secondary" size="sm" onClick={onOpenProviders}>
                Открыть провайдеры
              </Button>
            )}
          </div>

          {/* Secrets status pill list */}
          <div className="pt-2 border-t border-[var(--border)] space-y-1.5">
            <span className="text-[11px] text-[var(--text-muted)] block">Ключи и секреты окружения:</span>
            <div className="grid grid-cols-1 gap-1.5 text-xs">
              {Object.entries(secrets).map(([secKey, secStatus]) => (
                <div key={secKey} className="flex items-center justify-between p-1.5 rounded-[var(--radius-sm)] bg-[var(--surface-2)] border border-[var(--border)]">
                  <span className="font-mono text-[10px] text-[var(--text)] truncate" title={secKey}>{secKey}</span>
                  <StatusPill tone={secStatus === 'set' ? 'ok' : 'muted'}>
                    {secStatus === 'set' ? 'настроен' : 'не задан'}
                  </StatusPill>
                </div>
              ))}
            </div>
            <p className="text-[10px] text-[var(--text-subtle)] mt-1">
              Значения API ключей не передаются наружу и хранятся в защищённом окружении сервера.
            </p>
          </div>
        </div>

        {/* MCP & Discord */}
        <div className="space-y-4">
          {/* MCP Tools */}
          <div className="p-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] space-y-3">
            <div className="flex items-center justify-between border-b border-[var(--border)] pb-2.5">
              <h4 className="text-xs font-semibold text-[var(--text)] flex items-center gap-1.5">
                <Plug size={14} className="text-[var(--text-muted)]" />
                <span>MCP-серверы (инструменты ядра)</span>
              </h4>
              <StatusPill tone={config?.mcp?.enabled ? 'ok' : 'muted'}>
                {config?.mcp?.enabled ? 'включено' : 'отключено'}
              </StatusPill>
            </div>

            {Array.isArray(config?.mcp?.servers) && config.mcp.servers.length > 0 ? (
              <ul className="space-y-1 text-xs">
                {config.mcp.servers.map((srv) => (
                  <li key={srv.name} className="flex items-center justify-between py-1 border-b border-[var(--border)] last:border-0">
                    <span className="font-mono text-[var(--text)]">{srv.name}</span>
                    <StatusPill tone={srv.enabled ? 'ok' : 'muted'}>
                      {srv.enabled ? 'активен' : 'отключен'}
                    </StatusPill>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-[var(--text-muted)]">Ядро не отдало список MCP-серверов. Возможно, они не загружены при старте.</p>
            )}

            <div className="rounded-[var(--radius-sm)] p-2.5 bg-[var(--surface-2)] border border-[var(--border)] text-[11px] text-[var(--text-subtle)] leading-relaxed">
              Управление MCP-серверами (добавление, удаление, редактирование) станет доступно после интеграции соответствующего API ядра. Список серверов в настоящий момент доступен только для чтения.
            </div>
          </div>

          {/* Discord */}
          <div className="p-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] space-y-2.5">
            <div className="flex items-center justify-between border-b border-[var(--border)] pb-2">
              <h4 className="text-xs font-semibold text-[var(--text)] flex items-center gap-1.5">
                <Users size={14} className="text-[var(--text-muted)]" />
                <span>Discord интеграция</span>
              </h4>
              <StatusPill tone={integrations?.discord?.configured ? 'ok' : 'muted'}>
                {integrations?.discord?.configured ? 'настроен' : 'не настроен'}
              </StatusPill>
            </div>

            <p className="text-xs text-[var(--text-muted)] leading-relaxed">
              {integrations?.discord?.note ||
                (integrations?.discord?.configured
                  ? 'Вход пользователей через Discord активен. Настройки заданы в .env хоста.'
                  : 'DISCORD_CLIENT_ID и DISCORD_CLIENT_SECRET не заданы в .env. Авторизация через Discord отключена.')}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SECTION 4: ACCESS
// ---------------------------------------------------------------------------

interface UserItem {
  id: string;
  name?: string | null;
  email?: string | null;
  role?: string | null;
  banned?: boolean | null;
  createdAt?: string | null;
}

interface InviteItem {
  id: string;
  token?: string;
  code?: string;
  link?: string;
  expiresAt?: string;
  createdAt?: string;
  used?: boolean;
}

function AccessSection() {
  const [tab, setTab] = useState<'users' | 'invites'>('users');
  const [users, setUsers] = useState<UserItem[]>([]);
  const [invites, setInvites] = useState<InviteItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Invite creation
  const [newInviteTtl, setNewInviteTtl] = useState('24');
  const [creatingInvite, setCreatingInvite] = useState(false);
  const [createdInviteUrl, setCreatedInviteUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // User actions
  const [actionPendingId, setActionPendingId] = useState<string | null>(null);

  // Registration mode
  const [registrationMode, setRegistrationModeState] = useState<'invite' | 'open' | 'closed'>('invite');
  const [savingRegMode, setSavingRegMode] = useState(false);
  const [regModeError, setRegModeError] = useState<string | null>(null);
  const [regModeSaved, setRegModeSaved] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [uRes, iRes, sRes] = await Promise.all([
        fetch('/api/admin/users'),
        fetch('/api/admin/invites'),
        fetch('/api/admin/settings'),
      ]);
      const uJson = await uRes.json().catch(() => null);
      const iJson = await iRes.json().catch(() => null);
      const sJson = await sRes.json().catch(() => null);

      if (uJson?.items) setUsers(uJson.items);
      else if (Array.isArray(uJson?.data?.items)) setUsers(uJson.data.items);
      else if (Array.isArray(uJson)) setUsers(uJson);

      if (iJson?.items) setInvites(iJson.items);
      else if (Array.isArray(iJson?.data?.items)) setInvites(iJson.data.items);
      else if (Array.isArray(iJson)) setInvites(iJson);

      const mode = sJson?.data?.registration_mode ?? sJson?.registration_mode;
      if (mode === 'invite' || mode === 'open' || mode === 'closed') {
        setRegistrationModeState(mode);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить данные доступа.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleToggleRole = async (user: UserItem) => {
    const nextRole = user.role === 'admin' ? 'user' : 'admin';
    setActionPendingId(user.id);
    try {
      const res = await fetch(`/api/admin/users/${user.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: nextRole }),
      });
      if (res.ok) {
        setUsers((prev) =>
          prev.map((u) => (u.id === user.id ? { ...u, role: nextRole } : u))
        );
      }
    } catch {
    } finally {
      setActionPendingId(null);
    }
  };

  const handleToggleBan = async (user: UserItem) => {
    const nextBanned = !user.banned;
    setActionPendingId(user.id);
    try {
      const res = await fetch(`/api/admin/users/${user.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ banned: nextBanned }),
      });
      if (res.ok) {
        setUsers((prev) =>
          prev.map((u) => (u.id === user.id ? { ...u, banned: nextBanned } : u))
        );
      }
    } catch {
    } finally {
      setActionPendingId(null);
    }
  };

  const handleCreateInvite = async () => {
    setCreatingInvite(true);
    setCreatedInviteUrl(null);
    try {
      const res = await fetch('/api/admin/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttlHours: Number(newInviteTtl) || 24 }),
      });
      const json = await res.json().catch(() => null);
      if (res.ok && json?.data?.url) {
        setCreatedInviteUrl(json.data.url);
        void loadData();
      } else if (res.ok && json?.url) {
        setCreatedInviteUrl(json.url);
        void loadData();
      }
    } catch {
    } finally {
      setCreatingInvite(false);
    }
  };

  const handleCopyInvite = () => {
    if (!createdInviteUrl) return;
    navigator.clipboard?.writeText(createdInviteUrl).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSetRegistrationMode = async (mode: 'invite' | 'open' | 'closed') => {
    if (savingRegMode || mode === registrationMode) return;
    setSavingRegMode(true);
    setRegModeError(null);
    setRegModeSaved(false);
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ registration_mode: mode }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok) {
        const nextMode = data?.data?.registration_mode ?? data?.registration_mode ?? mode;
        setRegistrationModeState(nextMode);
        setRegModeSaved(true);
        setTimeout(() => setRegModeSaved(false), 2500);
      } else {
        setRegModeError(data?.message || 'Не удалось обновить режим регистрации');
      }
    } catch (e) {
      setRegModeError(e instanceof Error ? e.message : 'Ошибка соединения');
    } finally {
      setSavingRegMode(false);
    }
  };

  const filteredUsers = users.filter((u) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      (u.name && u.name.toLowerCase().includes(q)) ||
      (u.email && u.email.toLowerCase().includes(q)) ||
      u.id.toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-[var(--text)]">Доступ и аккаунты</h3>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            Список пользователей, генерация приглашений и политика регистрации
          </p>
        </div>

        {/* Tab switcher */}
        <div className="flex items-center gap-1 p-1 bg-[var(--surface)] border border-[var(--border)] rounded-[var(--radius-sm)]">
          <button
            type="button"
            onClick={() => setTab('users')}
            className={`px-3 py-1 text-xs font-medium rounded-[calc(var(--radius-sm)-2px)] transition-colors cursor-pointer ${
              tab === 'users'
                ? 'bg-[var(--surface-3)] text-[var(--text)] shadow-sm'
                : 'text-[var(--text-muted)] hover:text-[var(--text)]'
            }`}
          >
            Пользователи ({users.length})
          </button>
          <button
            type="button"
            onClick={() => setTab('invites')}
            className={`px-3 py-1 text-xs font-medium rounded-[calc(var(--radius-sm)-2px)] transition-colors cursor-pointer ${
              tab === 'invites'
                ? 'bg-[var(--surface-3)] text-[var(--text)] shadow-sm'
                : 'text-[var(--text-muted)] hover:text-[var(--text)]'
            }`}
          >
            Приглашения ({invites.length})
          </button>
        </div>
      </div>

      {loading ? (
        <LoadingState message="Загрузка списка доступа…" />
      ) : error ? (
        <ErrorState message={error} onRetry={loadData} />
      ) : tab === 'users' ? (
        <div className="space-y-3">
          {/* Search bar */}
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
            <input
              type="text"
              placeholder="Поиск по имени или email…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-3 py-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] text-xs text-[var(--text)] placeholder:text-[var(--text-subtle)] outline-none focus:border-[var(--accent)]"
            />
          </div>

          {/* User List */}
          <div className="border border-[var(--border)] rounded-[var(--radius)] bg-[var(--surface)] overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-[var(--surface-2)] border-b border-[var(--border)] text-[11px] font-medium text-[var(--text-muted)] uppercase">
                  <tr>
                    <th className="py-2.5 px-3">Пользователь</th>
                    <th className="py-2.5 px-3">Роль</th>
                    <th className="py-2.5 px-3">Статус</th>
                    <th className="py-2.5 px-3 text-right">Действия</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {filteredUsers.length > 0 ? (
                    filteredUsers.map((u) => (
                      <tr key={u.id} className="hover:bg-[var(--surface-2)]/60 transition-colors">
                        <td className="py-2.5 px-3">
                          <div className="font-medium text-[var(--text)]">{u.name || 'Без имени'}</div>
                          <div className="text-[11px] text-[var(--text-subtle)]">{u.email || u.id}</div>
                        </td>
                        <td className="py-2.5 px-3">
                          <StatusPill tone={u.role === 'admin' ? 'ok' : 'muted'}>
                            {u.role === 'admin' ? 'админ' : 'пользователь'}
                          </StatusPill>
                        </td>
                        <td className="py-2.5 px-3">
                          {u.banned ? (
                            <span className="inline-flex items-center gap-1 text-[var(--danger)] text-xs font-medium">
                              <Ban size={12} /> заблокирован
                            </span>
                          ) : (
                            <span className="text-[var(--text-subtle)] text-xs">активен</span>
                          )}
                        </td>
                        <td className="py-2.5 px-3 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={actionPendingId === u.id}
                              onClick={() => handleToggleRole(u)}
                            >
                              {u.role === 'admin' ? 'Снять админа' : 'Сделать админом'}
                            </Button>
                            <Button
                              variant={u.banned ? 'secondary' : 'danger'}
                              size="sm"
                              disabled={actionPendingId === u.id}
                              onClick={() => handleToggleBan(u)}
                            >
                              {u.banned ? 'Разблокировать' : 'Бан'}
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={4} className="py-6 text-center text-xs text-[var(--text-muted)]">
                        Пользователи не найдены.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : (
        /* Invites subview */
        <div className="space-y-4">
          {/* Create Invite bar */}
          <div className="p-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] space-y-3">
            <h4 className="text-xs font-semibold text-[var(--text)]">Создать приглашение</h4>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-[var(--text-muted)]">Срок действия:</span>
              <select
                value={newInviteTtl}
                onChange={(e) => setNewInviteTtl(e.target.value)}
                className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1 text-xs text-[var(--text)] outline-none"
              >
                <option value="24">24 часа (1 сутки)</option>
                <option value="72">72 часа (3 суток)</option>
                <option value="168">168 часов (7 суток)</option>
              </select>
              <Button
                variant="secondary"
                size="sm"
                disabled={creatingInvite}
                loading={creatingInvite}
                onClick={handleCreateInvite}
              >
                <Plus size={13} className="mr-1" />
                Сгенерировать ссылку
              </Button>
            </div>

            {createdInviteUrl && (
              <div className="p-2.5 rounded-[var(--radius-sm)] bg-[var(--surface-2)] border border-[var(--border-strong)] flex items-center justify-between gap-2">
                <span className="text-xs font-mono text-[var(--text)] truncate">{createdInviteUrl}</span>
                <Button variant="secondary" size="sm" onClick={handleCopyInvite}>
                  {copied ? <Check size={13} className="mr-1 text-[var(--success)]" /> : <Copy size={13} className="mr-1" />}
                  {copied ? 'Скопировано!' : 'Копировать'}
                </Button>
              </div>
            )}
          </div>

          {/* Invites list */}
          <div className="border border-[var(--border)] rounded-[var(--radius)] bg-[var(--surface)] overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-[var(--surface-2)] border-b border-[var(--border)] text-[11px] font-medium text-[var(--text-muted)] uppercase">
                  <tr>
                    <th className="py-2.5 px-3">Код / Ссылка</th>
                    <th className="py-2.5 px-3">Создано</th>
                    <th className="py-2.5 px-3">Статус</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {invites.length > 0 ? (
                    invites.map((inv) => (
                      <tr key={inv.id} className="hover:bg-[var(--surface-2)]/60 transition-colors">
                        <td className="py-2.5 px-3 font-mono text-[11px] text-[var(--text)]">
                          {inv.code || inv.token || inv.id}
                        </td>
                        <td className="py-2.5 px-3 text-[var(--text-muted)] text-[11px]">
                          {inv.createdAt ? new Date(inv.createdAt).toLocaleDateString('ru-RU') : '—'}
                        </td>
                        <td className="py-2.5 px-3">
                          <StatusPill tone={inv.used ? 'muted' : 'ok'}>
                            {inv.used ? 'использован' : 'активен'}
                          </StatusPill>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={3} className="py-6 text-center text-xs text-[var(--text-muted)]">
                        Активных приглашений пока нет.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Registration Mode Selector */}
      <div className="p-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Shield size={16} className="text-[var(--text-muted)] shrink-0" />
            <div>
              <h4 className="text-xs font-semibold text-[var(--text)]">Режим регистрации</h4>
              <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
                Политика создания новых учётных записей в системе
              </p>
            </div>
          </div>
          {regModeSaved && (
            <span className="inline-flex items-center gap-1 text-[11px] text-[var(--success)] font-medium">
              <Check size={12} /> Сохранено
            </span>
          )}
          {regModeError && (
            <span className="inline-flex items-center gap-1 text-[11px] text-[var(--danger)]">
              <AlertCircle size={12} /> {regModeError}
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-1">
          {[
            {
              id: 'invite',
              label: 'Только по инвайтам',
              desc: 'Регистрация только по действующей ссылке',
            },
            {
              id: 'open',
              label: 'Открытая',
              desc: 'Любой пользователь может зарегистрироваться',
            },
            {
              id: 'closed',
              label: 'Закрыта',
              desc: 'Новые регистрации запрещены',
            },
          ].map((item) => {
            const active = registrationMode === item.id;
            return (
              <button
                key={item.id}
                type="button"
                disabled={savingRegMode}
                onClick={() => void handleSetRegistrationMode(item.id as 'invite' | 'open' | 'closed')}
                className={`p-3 text-left rounded-[var(--radius-sm)] border transition-all cursor-pointer ${
                  active
                    ? 'border-[var(--accent)] bg-[var(--surface-3)] ring-1 ring-[var(--accent)]/30'
                    : 'border-[var(--border)] bg-[var(--surface-2)]/60 hover:bg-[var(--surface-2)] text-[var(--text-muted)]'
                } ${savingRegMode ? 'opacity-60 pointer-events-none' : ''}`}
              >
                <div className="flex items-center justify-between">
                  <span className={`text-xs font-medium ${active ? 'text-[var(--text)]' : 'text-[var(--text-muted)]'}`}>
                    {item.label}
                  </span>
                  {active && <span className="w-2 h-2 rounded-full bg-[var(--accent)]" />}
                </div>
                <p className="text-[10px] text-[var(--text-subtle)] mt-1">{item.desc}</p>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SECTION 5: SYSTEM
// ---------------------------------------------------------------------------

function SystemSection() {
  const [system, setSystem] = useState<SystemData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Restart modal
  const [restartConfirmOpen, setRestartConfirmOpen] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartMessage, setRestartMessage] = useState<string | null>(null);
  const [restartError, setRestartError] = useState<string | null>(null);

  const loadSystem = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/system');
      const json = await res.json().catch(() => null);
      if (!res.ok || json?.ok === false) {
        throw new Error(json?.message || 'Не удалось получить данные о системе.');
      }
      setSystem(json?.data || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки системы.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSystem();
  }, [loadSystem]);

  const handleRestartCore = async () => {
    setRestarting(true);
    setRestartError(null);
    setRestartMessage(null);
    try {
      const res = await fetch('/api/admin/system/restart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: 'core' }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || json?.ok === false) {
        throw new Error(json?.message || 'Команда перезапуска отклонена сервером.');
      }
      setRestartConfirmOpen(false);
      setRestartMessage(json?.data?.note || 'Команда перезапуска принята ядром Нейры.');
    } catch (err) {
      setRestartError(err instanceof Error ? err.message : 'Не удалось перезапустить ядро.');
    } finally {
      setRestarting(false);
    }
  };

  if (loading) {
    return <LoadingState message="Загрузка системной информации…" />;
  }

  if (error && !system) {
    return <ErrorState message={error} onRetry={loadSystem} />;
  }

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold text-[var(--text)]">Системные сервисы</h3>
        <p className="text-xs text-[var(--text-muted)] mt-0.5">
          Состояние окружения, диск, резервные копии и управление перезапуском ядра
        </p>
      </div>

      {restartMessage && (
        <div role="status" className="p-3 rounded-[var(--radius-sm)] bg-[var(--surface-3)] border border-[var(--border-strong)] text-xs text-[var(--text)] flex items-center gap-2">
          <Check size={14} className="text-[var(--success)]" />
          <span>{restartMessage}</span>
        </div>
      )}

      {restartError && !restartConfirmOpen && (
        <div role="alert" className="p-3 rounded-[var(--radius-sm)] bg-[var(--danger-quiet)] border border-[var(--danger)]/30 text-xs text-[var(--danger)] flex items-center gap-2">
          <AlertCircle size={14} />
          <span>{restartError}</span>
        </div>
      )}

      {/* Tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatTile
          label="Uptime сайта"
          value={formatSeconds(system?.site?.uptimeSeconds)}
          hint="процесс Next.js"
        />
        <StatTile
          label="Диск свободно"
          value={system?.site?.disk ? formatBytes(system.site.disk.freeBytes) : '—'}
          hint={system?.site?.disk ? `из ${formatBytes(system.site.disk.totalBytes)}` : 'недоступно'}
        />
        <StatTile
          label="Версия сайта"
          value={system?.site?.version || 'демо'}
          hint={system?.site?.commit ? `commit ${system.site.commit.slice(0, 7)}` : '—'}
        />
        <StatTile
          label="Uptime ядра"
          value={formatSeconds(system?.core?.health?.data?.uptime_seconds)}
          hint={system?.core?.health?.data?.version ? `версия ${system.core.health.data.version}` : '—'}
        />
      </div>

      {/* Restart Core Card */}
      <div className="p-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] space-y-3">
        <div className="flex items-center justify-between border-b border-[var(--border)] pb-2.5">
          <div>
            <h4 className="text-xs font-semibold text-[var(--text)]">Перезапуск ядра Нейры</h4>
            <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
              Мягкая остановка ядра. Systemd или Docker автоматически поднимут сервис заново.
            </p>
          </div>
          <Button variant="danger" size="sm" onClick={() => setRestartConfirmOpen(true)}>
            <RotateCw size={13} className="mr-1.5" />
            Перезапустить ядро
          </Button>
        </div>

        <p className="text-[11px] text-[var(--text-subtle)] leading-relaxed">
          Во время перезапуска чат и API ядра будут кратковременно недоступны (обычно 3–8 секунд). Все активные генерации будут корректно прерваны.
        </p>
      </div>

      {/* Backups Card */}
      <div className="p-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] space-y-3">
        <div className="flex items-center justify-between border-b border-[var(--border)] pb-2">
          <h4 className="text-xs font-semibold text-[var(--text)]">Резервные копии</h4>
          <span className="text-[11px] text-[var(--text-muted)]">
            {system?.site?.backups ? `${system.site.backups.items.length} шт.` : '—'}
          </span>
        </div>

        {Array.isArray(system?.site?.backups?.items) && system.site.backups.items.length > 0 ? (
          <ul className="space-y-1 text-xs">
            {system.site.backups.items.map((file, index) => {
              const name = typeof file === 'string' ? file : file.name;
              const size = typeof file === 'string' ? null : file.size ?? null;
              const modified = typeof file === 'string' ? null : file.modifiedAt ?? null;
              return (
                <li key={`${name}-${index}`} className="flex items-center justify-between gap-3 py-1 border-b border-[var(--border)] last:border-0">
                  <span className="font-mono text-[var(--text)] truncate">{name}</span>
                  <span className="shrink-0 text-[10px] text-[var(--text-subtle)]">
                    {size != null ? formatBytes(size) : 'архив'}{modified ? ` · ${modified.slice(0, 10)}` : ''}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-xs text-[var(--text-muted)]">Файлов резервных копий пока нет.</p>
        )}
      </div>

      {/* Restart Confirmation Dialog */}
      {restartConfirmOpen && (
        <div
          role="presentation"
          className="fixed inset-0 z-60 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-150"
        >
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="restart-dialog-title"
            className="w-full max-w-[420px] rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--surface-2)] p-5 space-y-4 shadow-panel text-[var(--text)]"
          >
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-[var(--danger-quiet)] text-[var(--danger)] flex items-center justify-center shrink-0">
                <AlertTriangle size={18} />
              </div>
              <div>
                <h4 id="restart-dialog-title" className="text-sm font-semibold text-[var(--text)]">
                  Перезапустить ядро Нейры?
                </h4>
                <p className="text-xs text-[var(--text-muted)] mt-0.5">
                  Сервис будет перезапущен через API
                </p>
              </div>
            </div>

            <p className="text-xs text-[var(--text-muted)] leading-relaxed">
              Ядро выполнит корректное завершение сессий и перезапуск. Пользовательские диалоги останутся в сохранности, но генерации ответов на несколько секунд прервутся.
            </p>

            {restartError && (
              <p role="alert" className="text-xs text-[var(--danger)] p-2 rounded bg-[var(--danger-quiet)]">
                {restartError}
              </p>
            )}

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-[var(--border)]">
              <Button
                variant="secondary"
                size="sm"
                disabled={restarting}
                onClick={() => setRestartConfirmOpen(false)}
              >
                Отмена
              </Button>
              <Button
                variant="danger"
                size="sm"
                disabled={restarting}
                loading={restarting}
                onClick={handleRestartCore}
              >
                {restarting ? 'Перезапуск…' : 'Подтвердить перезапуск'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared UI Helpers
// ---------------------------------------------------------------------------

function StatTile({
  label,
  value,
  hint,
  onClick,
}: {
  label: string;
  value: string | number;
  hint?: string;
  onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className={`p-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] flex flex-col justify-between ${
        onClick ? 'hover:border-[var(--border-strong)] cursor-pointer transition-colors' : ''
      }`}
    >
      <p className="text-[11px] text-[var(--text-muted)]">{label}</p>
      <p className="text-xl font-semibold tabular-nums text-[var(--text)] mt-1">{value}</p>
      {hint && <p className="text-[10px] text-[var(--text-subtle)] mt-1 truncate">{hint}</p>}
    </div>
  );
}

function LoadingState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center space-y-3">
      <RefreshCw size={22} className="animate-spin text-[var(--text-muted)]" />
      <p className="text-xs text-[var(--text-muted)]">{message}</p>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="p-6 rounded-[var(--radius)] border border-[var(--danger)]/30 bg-[var(--danger-quiet)] text-center space-y-3 my-6">
      <AlertCircle size={22} className="mx-auto text-[var(--danger)]" />
      <div>
        <p className="text-xs font-medium text-[var(--danger)]">{message}</p>
        <p className="text-[11px] text-[var(--text-muted)] mt-1">
          Проверьте доступность API ядра или повторите попытку запроса.
        </p>
      </div>
      <div>
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Повторить попытку
        </Button>
      </div>
    </div>
  );
}

function formatSeconds(sec?: number | null): string {
  if (!sec || sec <= 0) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}д ${h}ч`;
  if (h > 0) return `${h}ч ${m}м`;
  return `${m}м`;
}

function formatBytes(bytes?: number | null): string {
  if (!bytes || bytes <= 0) return '—';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size.toFixed(size >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}
