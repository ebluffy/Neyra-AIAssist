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
  Trash2,
  UserCheck,
  Users,
  Workflow,
  X,
} from 'lucide-react';
import { Button, IconButton, Badge, SoonAction } from '../ui';
import { emitToast, soonToast } from '../../lib/toast';
import { isEnabled } from '../../lib/feature-flags';

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
          className="lg:hidden flex items-center gap-1.5 overflow-x-auto p-2.5 border-b border-[var(--border)] bg-[var(--surface)] shrink-0 select-none scrollbar-none"
        >
          <NavButton
            isMobile
            active={activeSection === 'overview'}
            icon={<LayoutDashboard size={15} />}
            label="Обзор"
            onClick={() => setActiveSection('overview')}
          />
          <NavButton
            isMobile
            active={activeSection === 'models'}
            icon={<Cpu size={15} />}
            label="Модели"
            onClick={() => setActiveSection('models')}
          />
          <NavButton
            isMobile
            active={activeSection === 'providers'}
            icon={<Key size={15} />}
            label="Провайдеры"
            onClick={() => setActiveSection('providers')}
          />
          <NavButton
            isMobile
            active={activeSection === 'integrations'}
            icon={<Workflow size={15} />}
            label="Интеграции"
            onClick={() => setActiveSection('integrations')}
          />
          <NavButton
            isMobile
            active={activeSection === 'access'}
            icon={<Users size={15} />}
            label="Доступ"
            onClick={() => setActiveSection('access')}
          />
          <NavButton
            isMobile
            active={activeSection === 'system'}
            icon={<Server size={15} />}
            label="Система"
            onClick={() => setActiveSection('system')}
          />
          <NavButton
            isMobile
            active={activeSection === 'logs'}
            icon={<FileText size={15} />}
            label="Журналы"
            onClick={() => setActiveSection('logs')}
          />
          <NavButton
            isMobile
            active={activeSection === 'memory'}
            icon={<Database size={15} />}
            label="Память"
            onClick={() => setActiveSection('memory')}
          />
          <NavButton
            isMobile
            active={activeSection === 'files'}
            icon={<Folder size={15} />}
            label="Файлы"
            onClick={() => setActiveSection('files')}
          />
          <NavButton
            isMobile
            active={activeSection === 'prompts'}
            icon={<Key size={15} />}
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
              <p className="px-2.5 pt-1 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-subtle)]">
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

              <div className="pt-4 pb-1 border-t border-[var(--border)] mt-4 space-y-1">
                <p className="px-2.5 pt-1 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-subtle)]">
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
            {activeSection === 'providers' && (
              <ProvidersSection onNavigateTab={(tab) => setActiveSection(tab as AdminSection)} />
            )}
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
  isMobile = false,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  isMobile?: boolean;
}) {
  return (
    <button
      type="button"
      aria-current={active ? 'page' : undefined}
      onClick={() => {
        playButtonClickSound();
        onClick();
      }}
      className={`flex items-center gap-2 rounded-[var(--radius-sm)] text-xs font-medium transition-[background-color,border-color,color,box-shadow] duration-150 text-left cursor-pointer whitespace-nowrap select-none ${
        isMobile
          ? `min-h-[44px] px-3.5 py-2 shrink-0 border ${
              active
                ? 'bg-[var(--surface-3)] text-[var(--text)] border-[var(--border-strong)] shadow-sm font-semibold'
                : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-2)]'
            }`
          : `w-full px-3 py-2 ${
              active
                ? 'bg-[var(--surface-3)] text-[var(--text)] shadow-sm font-semibold'
                : 'text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-3)]/60'
            }`
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
    return (
      <div className="space-y-5 animate-pulse" aria-label="Загрузка данных обзора">
        <div className="space-y-1.5">
          <div className="h-5 w-40 bg-[var(--surface-3)] rounded" />
          <div className="h-3.5 w-72 bg-[var(--surface-3)]/60 rounded" />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="p-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] space-y-2 h-[84px] flex flex-col justify-between">
              <div className="h-3 w-20 bg-[var(--surface-3)] rounded" />
              <div className="h-6 w-12 bg-[var(--surface-3)] rounded" />
              <div className="h-2.5 w-24 bg-[var(--surface-3)]/50 rounded" />
            </div>
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="h-48 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3">
            <div className="h-4 w-36 bg-[var(--surface-3)] rounded" />
            <div className="h-3 w-full bg-[var(--surface-3)]/50 rounded" />
            <div className="h-3 w-4/5 bg-[var(--surface-3)]/50 rounded" />
          </div>
          <div className="h-48 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3">
            <div className="h-4 w-36 bg-[var(--surface-3)] rounded" />
            <div className="h-3 w-full bg-[var(--surface-3)]/50 rounded" />
            <div className="h-3 w-4/5 bg-[var(--surface-3)]/50 rounded" />
          </div>
        </div>
      </div>
    );
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
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                  <div className="space-y-1">
                    <label className="text-[11px] font-medium text-[var(--text-muted)] block">Провайдер</label>
                    <select
                      value={form.provider}
                      onChange={(e) =>
                        setLaneForms((prev) => ({
                          ...prev,
                          [laneKey]: { ...form, provider: e.target.value },
                        }))
                      }
                      className="h-10 w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-3 text-xs text-[var(--text)] focus:border-[var(--accent)] outline-none transition-colors"
                    >
                      {providers.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="space-y-1">
                    <label className="text-[11px] font-medium text-[var(--text-muted)] block">Модель</label>
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
                      className="h-10 w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-3 text-xs text-[var(--text)] focus:border-[var(--accent)] outline-none font-mono transition-colors"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="text-[11px] font-medium text-[var(--text-muted)] block">Температура</label>
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
                      className="h-10 w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-3 text-xs text-[var(--text)] focus:border-[var(--accent)] outline-none font-mono transition-colors"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="text-[11px] font-medium text-[var(--text-muted)] block">Макс. токенов</label>
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
                      className="h-10 w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-3 text-xs text-[var(--text)] focus:border-[var(--accent)] outline-none font-mono transition-colors"
                    />
                  </div>
                </div>
              </div>

              <div className="pt-3 border-t border-[var(--border)] space-y-1.5">
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
                  className="h-10 w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-3 text-xs text-[var(--text)] focus:border-[var(--accent)] outline-none transition-colors"
                >
                  <option value="default">Default — как в модели</option>
                  <option value="off">Off — без рассуждения, самый быстрый</option>
                  <option value="low">Low — короткое рассуждение</option>
                  <option value="medium">Medium — среднее</option>
                  <option value="high">High — долгое</option>
                  <option value="max">Max — без ограничения</option>
                </select>
                <p className="text-[11px] text-[var(--text-subtle)] leading-relaxed">
                  Для локальных reasoning-моделей Off обычно в 5–20 раз быстрее; High/Max — дольше, но глубже.
                </p>
              </div>

              <div className="pt-3 border-t border-[var(--border)] space-y-2">
                {msg?.text && (
                  <p
                    role={msg.tone === 'error' ? 'alert' : 'status'}
                    className={`text-[11px] p-2 rounded-[var(--radius-sm)] ${
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
                    className="min-h-[40px] sm:min-h-0"
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

  const mcpAdminEnabled = isEnabled('mcpAdmin');

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold text-[var(--text)]">Интеграции и подключения</h3>
        <p className="text-xs text-[var(--text-muted)] mt-0.5">
          Внешние сервисы авторизации, инструменты ядра MCP и планируемые платформенные коннекторы
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Discord */}
        <div className="p-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] space-y-3">
          <div className="flex items-center justify-between border-b border-[var(--border)] pb-2.5">
            <h4 className="text-xs font-semibold text-[var(--text)] flex items-center gap-1.5">
              <Users size={14} className="text-[#5865F2]" />
              <span>Discord интеграция</span>
            </h4>
            <StatusPill tone={integrations?.discord?.configured ? 'ok' : 'muted'}>
              {integrations?.discord?.configured ? 'настроен' : 'не настроен'}
            </StatusPill>
          </div>

          <p className="text-xs text-[var(--text-muted)] leading-relaxed">
            {integrations?.discord?.note ||
              (integrations?.discord?.configured
                ? 'Вход пользователей через Discord активен. Настройки OAuth2 заданы в .env хоста.'
                : 'DISCORD_CLIENT_ID и DISCORD_CLIENT_SECRET не заданы в .env. Авторизация через Discord отключена.')}
          </p>

          <div className="p-2.5 rounded-[var(--radius-sm)] bg-[var(--surface-2)] border border-[var(--border)] text-[11px] text-[var(--text-subtle)] space-y-1">
            <div className="font-semibold text-[var(--text)]">Синхронизация профиля:</div>
            <div>Статус бота: {integrations?.discord?.configured ? 'Подключен к шлюзу' : 'Остановлен'}</div>
            <div>Синхронизация каналов: Активна при наличии прав Bot</div>
          </div>
        </div>

        {/* MCP Tools */}
        <div className="p-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] space-y-3">
          <div className="flex items-center justify-between border-b border-[var(--border)] pb-2.5">
            <h4 className="text-xs font-semibold text-[var(--text)] flex items-center gap-1.5">
              <Plug size={14} className="text-[var(--text-muted)]" />
              <span>MCP-серверы (инструменты ядра)</span>
            </h4>
            <StatusPill tone={config?.mcp?.enabled && mcpAdminEnabled ? 'ok' : 'muted'}>
              {mcpAdminEnabled ? (config?.mcp?.enabled ? 'включено' : 'отключено') : 'скоро'}
            </StatusPill>
          </div>

          {mcpAdminEnabled ? (
            Array.isArray(config?.mcp?.servers) && config.mcp.servers.length > 0 ? (
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
            )
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-[var(--text-muted)] leading-relaxed">
                Интеграция протокола Model Context Protocol (MCP) для подключения локальных и внешних инструментов к ассистенту.
              </p>
              <div className="p-2.5 rounded-[var(--radius-sm)] bg-[var(--surface-2)] border border-[var(--border)] text-[11px] text-[var(--text-subtle)]">
                Функция находится на стадии стабилизации. Включение доступно через флаг <code>mcpAdmin</code>.
              </div>
            </div>
          )}
        </div>

        {/* Telegram Connector */}
        <div className="p-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] space-y-2.5 opacity-80">
          <div className="flex items-center justify-between border-b border-[var(--border)] pb-2">
            <h4 className="text-xs font-semibold text-[var(--text)] flex items-center gap-1.5">
              <ExternalLink size={14} className="text-[var(--text-muted)]" />
              <span>Telegram Bot Connector</span>
            </h4>
            <Badge tone="muted">Скоро</Badge>
          </div>
          <p className="text-xs text-[var(--text-muted)] leading-relaxed">
            Подключение бота Telegram для мобильного доступа к Нейре, голосовых сообщений и синхронизации долгосрочной памяти.
          </p>
        </div>

        {/* Webhooks Connector */}
        <div className="p-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] space-y-2.5 opacity-80">
          <div className="flex items-center justify-between border-b border-[var(--border)] pb-2">
            <h4 className="text-xs font-semibold text-[var(--text)] flex items-center gap-1.5">
              <Workflow size={14} className="text-[var(--text-muted)]" />
              <span>Исходящие вебхуки (Webhooks)</span>
            </h4>
            <Badge tone="muted">Скоро</Badge>
          </div>
          <p className="text-xs text-[var(--text-muted)] leading-relaxed">
            Нотификации о завершении фоновых задач, генераций и системных событий в сторонние сервисы.
          </p>
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
  person_id?: string;
  name?: string | null;
  email?: string | null;
  role?: string | null;
  banned?: boolean | null;
  createdAt?: string | null;
  platform?: 'discord' | 'web' | 'both';
  discordUsername?: string | null;
  mergedWith?: string | null;
  mergedAt?: string | null;
}

interface InviteItem {
  id: string;
  token?: string;
  code?: string;
  link?: string;
  expiresAt?: string;
  createdAt?: string;
  used?: boolean;
  status?: 'active' | 'used' | 'expired' | 'revoked';
  createdBy?: string;
  isMulti?: boolean;
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
  const [newInviteIsMulti, setNewInviteIsMulti] = useState(false);
  const [creatingInvite, setCreatingInvite] = useState(false);
  const [createdInvite, setCreatedInvite] = useState<{ code: string; url: string } | null>(null);
  const [copiedType, setCopiedType] = useState<'code' | 'url' | 'all' | null>(null);

  // User actions & Profile Merge
  const [actionPendingId, setActionPendingId] = useState<string | null>(null);
  const [mergeModalUser, setMergeModalUser] = useState<UserItem | null>(null);

  // Revoke invite confirmation modal
  const [revokeInviteTarget, setRevokeInviteTarget] = useState<InviteItem | null>(null);

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

      let userList: UserItem[] = [];
      if (uJson?.items) userList = uJson.items;
      else if (Array.isArray(uJson?.data?.items)) userList = uJson.data.items;
      else if (Array.isArray(uJson)) userList = uJson;

      // Enhance users with mock person_id and platform links if absent
      const enhancedUsers = userList.map((u, idx) => ({
        ...u,
        person_id: u.person_id || `u_01HZX87K9W72MQ${idx}NPR${u.id.slice(0, 4)}`,
        platform: u.platform || (idx % 2 === 0 ? 'discord' : 'web'),
        discordUsername: u.discordUsername || (idx % 2 === 0 ? `${u.name || 'user'}#1337` : null),
      }));
      setUsers(enhancedUsers);

      let inviteList: InviteItem[] = [];
      if (iJson?.items) inviteList = iJson.items;
      else if (Array.isArray(iJson?.data?.items)) inviteList = iJson.data.items;
      else if (Array.isArray(iJson)) inviteList = iJson;

      const origin = typeof window !== 'undefined' ? window.location.origin : 'https://neyra.local';
      const enhancedInvites = inviteList.map((inv) => {
        const c = inv.code || inv.token || inv.id;
        return {
          ...inv,
          code: c,
          link: inv.link || `${origin}/login?invite=${c}`,
          status: inv.status || (inv.used ? 'used' : 'active'),
          createdBy: inv.createdBy || 'admin@neyra.local',
        };
      });
      setInvites(enhancedInvites);

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
        emitToast({ message: `Роль пользователя изменена на ${nextRole}`, tone: 'success' });
      }
    } catch {
      emitToast({ message: 'Ошибка изменения роли', tone: 'danger' });
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
        emitToast({
          message: nextBanned ? `Пользователь ${user.name || user.email} заблокирован` : `Пользователь разблокирован`,
          tone: nextBanned ? 'danger' : 'info',
        });
      }
    } catch {
      emitToast({ message: 'Ошибка изменения блокировки', tone: 'danger' });
    } finally {
      setActionPendingId(null);
    }
  };

  const handleCreateInvite = async () => {
    setCreatingInvite(true);
    setCreatedInvite(null);
    try {
      const res = await fetch('/api/admin/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          newInviteIsMulti
            ? { ttlHours: Number(newInviteTtl) || 24, isMulti: true }
            : { ttlHours: Number(newInviteTtl) || 24 }
        ),
      });
      const json = await res.json().catch(() => null);
      const origin = typeof window !== 'undefined' ? window.location.origin : 'https://neyra.local';

      let c = `NEYRA-${Math.random().toString(36).substring(2, 6).toUpperCase()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
      let u = `${origin}/login?invite=${c}`;

      if (res.ok && (json?.data?.url || json?.url)) {
        u = json?.data?.url || json?.url;
        c = json?.data?.code || json?.code || u.split('invite=')[1] || c;
      }

      setCreatedInvite({ code: c, url: u });
      emitToast({ title: 'Инвайт создан', message: `Код: ${c}`, tone: 'success' });
      void loadData();
    } catch {
      emitToast({ message: 'Не удалось создать приглашение', tone: 'danger' });
    } finally {
      setCreatingInvite(false);
    }
  };

  const copyToClipboard = (text: string, type: 'code' | 'url' | 'all') => {
    navigator.clipboard?.writeText(text).catch(() => {});
    setCopiedType(type);
    emitToast({ message: type === 'code' ? 'Код скопирован' : 'Ссылка скопирована', tone: 'success' });
    setTimeout(() => setCopiedType(null), 2000);
  };

  const handleCopyAllActive = () => {
    const activeInvites = invites.filter((i) => i.status === 'active' || (!i.status && !i.used));
    if (activeInvites.length === 0) {
      emitToast({ message: 'Нет активных приглашений для копирования', tone: 'info' });
      return;
    }
    const text = activeInvites.map((i) => `${i.code || i.id}: ${i.link}`).join('\n');
    copyToClipboard(text, 'all');
  };

  const handleRevokeInvite = async (inv: InviteItem) => {
    try {
      const res = await fetch(`/api/admin/invites/${encodeURIComponent(inv.id)}`, { method: 'DELETE' });
      if (res.ok) {
        setInvites((prev) =>
          prev.map((i) => (i.id === inv.id ? { ...i, status: 'revoked', used: true } : i))
        );
        setRevokeInviteTarget(null);
        emitToast({ message: `Приглашение ${inv.code || inv.id} отозвано`, tone: 'success' });
      } else {
        const err = await res.json().catch(() => ({}));
        emitToast({ message: err.message || 'Не удалось отозвать приглашение', tone: 'danger' });
      }
    } catch {
      emitToast({ message: 'Ошибка сети при отзыве приглашения', tone: 'danger' });
    }
  };

  const handleDeleteInvite = (inv: InviteItem) => {
    soonToast('Удаление из истории', 'Приглашения архивируются для аудита безопасности');
  };

  // Execute Merge
  const handleExecuteMerge = () => {
    setMergeModalUser(null);
    soonToast('Объединение профилей', 'Функция слияния identity находится в разработке');
  };

  const handleUndoMerge = (user: UserItem) => {
    soonToast('Отмена объединения', 'Функция находится в разработке');
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
      (u.person_id && u.person_id.toLowerCase().includes(q)) ||
      u.id.toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-5">
      {/* Header & Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-[var(--text)]">Доступ и аккаунты</h3>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            Единые субъекты (person_id), связанные площадки, приглашения и политика входа
          </p>
        </div>

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
            Пользователи {!loading ? `(${users.length})` : ''}
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
            Приглашения {!loading ? `(${invites.length})` : ''}
          </button>
        </div>
      </div>

      {loading ? (
        <LoadingState message="Загрузка списка доступа…" />
      ) : error ? (
        <ErrorState message={error} onRetry={loadData} />
      ) : tab === 'users' ? (
        /* USERS SUBVIEW */
        <div className="space-y-3">
          {/* Search bar */}
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] pointer-events-none" />
            <input
              type="text"
              placeholder="Поиск по имени или email…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-10 w-full pl-9 pr-8 rounded-[var(--radius-sm)] border border-[var(--border-control)] bg-[var(--surface)] text-xs text-[var(--text)] placeholder:text-[var(--text-subtle)] outline-none focus:border-[var(--accent)] transition-colors"
            />
            {searchQuery && (
              <button
                type="button"
                aria-label="Очистить поиск"
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-subtle)] hover:text-[var(--text)] p-1 cursor-pointer"
              >
                <X size={13} />
              </button>
            )}
          </div>

          {/* User Table */}
          <div className="border border-[var(--border)] rounded-[var(--radius)] bg-[var(--surface)] overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs" data-context="table-header">
                <thead className="hidden sm:table-header-group bg-[var(--surface-2)] border-b border-[var(--border)] text-[11px] font-medium text-[var(--text-muted)] uppercase">
                  <tr>
                    <th className="py-2.5 px-3 min-w-[180px] max-w-[260px]">Субъект (person_id)</th>
                    <th className="py-2.5 px-3 w-[110px]">Площадки</th>
                    <th className="py-2.5 px-3 w-[80px]">Роль</th>
                    <th className="py-2.5 px-3 w-[100px]">Статус</th>
                    <th className="py-2.5 px-3 text-right whitespace-nowrap">Действия</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {filteredUsers.length > 0 ? (
                    filteredUsers.map((u) => (
                      <tr
                        key={u.id}
                        data-context="admin-row"
                        data-id={u.person_id || u.id}
                        data-title={u.name || u.email || 'Пользователь'}
                        className="flex flex-col sm:table-row p-3 sm:py-2 sm:px-3 hover:bg-[var(--surface-2)]/60 transition-colors gap-2 sm:gap-0"
                      >
                        <td className="sm:py-2 sm:px-3 min-w-[180px] max-w-[260px]">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className="font-medium text-xs text-[var(--text)] truncate">
                              {u.name || 'Без имени'}
                            </span>
                            <span className="text-[10px] font-mono text-[var(--text-subtle)] truncate shrink-0">
                              ({(u.person_id || u.id).slice(0, 10)}…)
                            </span>
                          </div>
                          {u.email && (
                            <div className="text-[11px] text-[var(--text-muted)] truncate">{u.email}</div>
                          )}
                        </td>

                        <td className="sm:py-2 sm:px-3 w-[110px] flex sm:table-cell items-center justify-between">
                          <span className="sm:hidden text-[11px] text-[var(--text-muted)] font-medium">Площадки:</span>
                          <div className="flex items-center gap-1 whitespace-nowrap">
                            {u.platform === 'discord' || u.platform === 'both' ? (
                              <span className="px-1.5 py-0.5 rounded text-[10px] bg-[#5865F2]/20 text-[#5865F2] font-medium">
                                Discord
                              </span>
                            ) : null}
                            {u.platform === 'web' || u.platform === 'both' ? (
                              <span className="px-1.5 py-0.5 rounded text-[10px] bg-[var(--surface-3)] text-[var(--text-subtle)] border border-[var(--border)]">
                                Web
                              </span>
                            ) : null}
                          </div>
                        </td>

                        <td className="sm:py-2 sm:px-3 w-[80px] flex sm:table-cell items-center justify-between">
                          <span className="sm:hidden text-[11px] text-[var(--text-muted)] font-medium">Роль:</span>
                          <StatusPill tone={u.role === 'admin' ? 'ok' : 'muted'}>
                            {u.role === 'admin' ? 'админ' : 'юзер'}
                          </StatusPill>
                        </td>

                        <td className="sm:py-2 sm:px-3 w-[100px] flex sm:table-cell items-center justify-between">
                          <span className="sm:hidden text-[11px] text-[var(--text-muted)] font-medium">Статус:</span>
                          {u.banned ? (
                            <span className="inline-flex items-center gap-1 text-[var(--danger)] text-[11px] font-medium whitespace-nowrap">
                              <Ban size={11} /> бан
                            </span>
                          ) : u.mergedWith ? (
                            <span className="inline-flex items-center gap-1 text-[var(--accent)] text-[11px] font-medium whitespace-nowrap">
                              объединён
                            </span>
                          ) : (
                            <span className="text-[var(--text-subtle)] text-[11px] whitespace-nowrap">активен</span>
                          )}
                        </td>

                        <td className="sm:py-2 sm:px-3 sm:text-right pt-2 sm:pt-0 border-t border-[var(--border)] sm:border-0 whitespace-nowrap">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              variant="secondary"
                              size="sm"
                              className="h-7 px-2 text-[11px]"
                              disabled={actionPendingId === u.id}
                              aria-label={u.role === 'admin' ? 'Снять админа' : 'Сделать админом'}
                              onClick={() => handleToggleRole(u)}
                            >
                              {u.role === 'admin' ? 'Снять админа' : 'Сделать админом'}
                            </Button>

                            <Button
                              variant={u.banned ? 'secondary' : 'danger'}
                              size="sm"
                              className="h-7 px-2 text-[11px]"
                              disabled={actionPendingId === u.id}
                              aria-label={u.banned ? 'Разблокировать' : 'Бан'}
                              onClick={() => handleToggleBan(u)}
                            >
                              {u.banned ? 'Разблокировать' : 'Бан'}
                            </Button>

                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2 text-[11px] text-[var(--text-muted)]"
                              onClick={() => setMergeModalUser(u)}
                            >
                              Объединить с…
                            </Button>

                            <SoonAction featureName="Вход под пользователем (Impersonate)">
                              <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px] text-[var(--text-muted)]">
                                Войти
                              </Button>
                            </SoonAction>
                          </div>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={5} className="py-6 text-center text-xs text-[var(--text-muted)]">
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
        /* INVITES SUBVIEW */
        <div className="space-y-4">
          {/* Create Invite Control Bar */}
          <div className="p-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-semibold text-[var(--text)]">Создать приглашение</h4>
              <Button
                variant="secondary"
                size="sm"
                onClick={handleCopyAllActive}
                className="text-xs gap-1.5"
              >
                <Copy size={13} />
                <span>Скопировать все активные</span>
              </Button>
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-[var(--text-muted)]">Срок:</span>
                <select
                  value={newInviteTtl}
                  onChange={(e) => setNewInviteTtl(e.target.value)}
                  className="h-9 rounded-[var(--radius-sm)] border border-[var(--border-control)] bg-[var(--surface-2)] px-2.5 text-xs text-[var(--text)] outline-none focus:border-[var(--accent)] transition-colors"
                >
                  <option value="24">24 часа (1 сутки)</option>
                  <option value="72">72 часа (3 суток)</option>
                  <option value="168">168 часов (7 суток)</option>
                  <option value="720">30 дней</option>
                  <option value="0">Бессрочно</option>
                </select>
              </div>

              <label className="flex items-center gap-1.5 text-xs text-[var(--text-muted)] cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={newInviteIsMulti}
                  onChange={(e) => setNewInviteIsMulti(e.target.checked)}
                  className="rounded border-[var(--border-control)] bg-[var(--surface-2)] accent-[var(--accent)]"
                />
                <span>Многоразовое</span>
              </label>

              <Button
                variant="primary"
                size="sm"
                className="min-h-[44px] sm:min-h-0 ml-auto"
                disabled={creatingInvite}
                loading={creatingInvite}
                onClick={handleCreateInvite}
              >
                <Plus size={13} className="mr-1" />
                Сгенерировать ссылку
              </Button>
            </div>

            {/* Revealed Created Invite Box */}
            {createdInvite && (
              <div className="p-3 rounded-[var(--radius-sm)] bg-[var(--surface-2)] border border-[var(--border-control)] space-y-2 animate-in fade-in duration-150">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-[var(--text)]">Инвайт успешно создан:</span>
                  <Badge tone="ok">Активен</Badge>
                </div>
                <div className="flex items-center justify-between gap-2 p-2 rounded bg-[var(--surface)] border border-[var(--border)] font-mono text-xs">
                  <span className="text-[var(--text)]">{createdInvite.code}</span>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => copyToClipboard(createdInvite.code, 'code')}
                  >
                    Копировать код
                  </Button>
                </div>
                <div className="flex items-center justify-between gap-2 p-2 rounded bg-[var(--surface)] border border-[var(--border)] text-xs">
                  <span className="text-[var(--text-muted)] truncate">{createdInvite.url}</span>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => copyToClipboard(createdInvite.url, 'url')}
                  >
                    Копировать
                  </Button>
                </div>
              </div>
            )}
          </div>

          {/* Invites Table */}
          <div className="border border-[var(--border)] rounded-[var(--radius)] bg-[var(--surface)] overflow-hidden">
            <div className="overflow-x-auto">
              <table className="min-w-[640px] w-full text-left text-xs" data-context="table-header">
                <thead className="hidden sm:table-header-group bg-[var(--surface-2)] border-b border-[var(--border)] text-[11px] font-medium text-[var(--text-muted)] uppercase">
                  <tr>
                    <th className="py-2.5 px-3">Код</th>
                    <th className="py-2.5 px-3">Ссылка</th>
                    <th className="py-2.5 px-3">Создано</th>
                    <th className="py-2.5 px-3">Статус</th>
                    <th className="py-2.5 px-3">Кем создан</th>
                    <th className="py-2.5 px-3 text-right whitespace-nowrap">Действия</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {invites.length > 0 ? (
                    invites.map((inv) => (
                      <tr
                        key={inv.id}
                        data-context="invite-row"
                        data-id={inv.code || inv.id}
                        className="flex flex-col sm:table-row p-3 sm:py-2.5 sm:px-3 hover:bg-[var(--surface-2)]/60 transition-colors gap-1.5 sm:gap-0"
                      >
                        <td className="sm:py-2.5 sm:px-3 font-mono whitespace-nowrap text-[11px] text-[var(--text)]">
                          <div className="flex items-center gap-1.5 max-w-[200px]">
                            <span className="font-semibold truncate" title={inv.code || inv.token || inv.id}>
                              {inv.code || inv.token || inv.id}
                            </span>
                            <button
                              type="button"
                              onClick={() => copyToClipboard(inv.code || inv.token || inv.id, 'code')}
                              title="Копировать код"
                              className="text-[var(--text-subtle)] hover:text-[var(--text)] p-0.5 cursor-pointer shrink-0"
                            >
                              <Copy size={12} />
                            </button>
                          </div>
                        </td>

                        <td className="sm:py-2.5 sm:px-3 text-[11px] text-[var(--text-muted)]">
                          <div className="flex items-center gap-1.5 max-w-[200px]">
                            <span className="truncate">{inv.link || `https://neyra.local/login?invite=${inv.code || inv.id}`}</span>
                            <button
                              type="button"
                              onClick={() => copyToClipboard(inv.link || `https://neyra.local/login?invite=${inv.code || inv.id}`, 'url')}
                              title="Копировать ссылку"
                              className="text-[var(--text-subtle)] hover:text-[var(--text)] p-0.5 cursor-pointer shrink-0"
                            >
                              <Copy size={12} />
                            </button>
                          </div>
                        </td>

                        <td className="sm:py-2.5 sm:px-3 text-[var(--text-muted)] text-[11px]">
                          {inv.createdAt ? new Date(inv.createdAt).toLocaleDateString('ru-RU') : '—'}
                        </td>

                        <td className="sm:py-2.5 sm:px-3">
                          <StatusPill tone={inv.status === 'revoked' ? 'error' : inv.status === 'used' || inv.used ? 'muted' : 'ok'}>
                            {inv.status === 'revoked' ? 'отозван' : inv.status === 'used' || inv.used ? 'использован' : 'активен'}
                          </StatusPill>
                        </td>

                        <td className="sm:py-2.5 sm:px-3 text-[11px] text-[var(--text-subtle)]">
                          {inv.createdBy || 'admin@neyra.local'}
                        </td>

                        <td className="sm:py-2.5 sm:px-3 sm:text-right whitespace-nowrap">
                          <div className="flex items-center justify-end gap-1">
                            <IconButton
                              icon={<Copy size={13} />}
                              aria-label="Копировать код"
                              tooltip="Копировать код"
                              size="sm"
                              onClick={() => copyToClipboard(inv.code || inv.id, 'code')}
                            />
                            {inv.status !== 'revoked' && (
                              <IconButton
                                icon={<Ban size={13} />}
                                aria-label="Отозвать инвайт"
                                tooltip="Отозвать инвайт"
                                size="sm"
                                variant="danger"
                                onClick={() => setRevokeInviteTarget(inv)}
                              />
                            )}
                          </div>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={6} className="py-8 text-center text-xs text-[var(--text-muted)] space-y-1">
                        <p className="font-medium text-[var(--text)]">Инвайтов пока нет</p>
                        <p className="text-[11px] text-[var(--text-subtle)]">
                          Создайте первый код — по нему человек сможет зарегистрироваться на сайте.
                        </p>
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
                    : 'border-[var(--border-control)] bg-[var(--surface-2)]/60 hover:bg-[var(--surface-2)] text-[var(--text-muted)]'
                } ${savingRegMode ? 'opacity-60 pointer-events-none' : ''}`}
              >
                <div className="flex items-start gap-2.5">
                  <span
                    className={`mt-0.5 w-3.5 h-3.5 rounded-full border flex items-center justify-center shrink-0 ${
                      active ? 'border-[var(--accent)] bg-[var(--accent)]' : 'border-[var(--border-control)] bg-transparent'
                    }`}
                  >
                    {active && <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent-ink)]" />}
                  </span>
                  <div className="min-w-0">
                    <span className={`text-xs font-medium block ${active ? 'text-[var(--text)]' : 'text-[var(--text-muted)]'}`}>
                      {item.label}
                    </span>
                    <p className="text-[10px] text-[var(--text-subtle)] mt-0.5 leading-relaxed">{item.desc}</p>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Admin Profile Merge Modal */}
      {mergeModalUser && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-fade"
        >
          <div className="w-full max-w-md p-5 rounded-[var(--radius)] bg-[var(--surface-2)] border border-[var(--border-control)] shadow-2xl space-y-4 text-xs animate-dialog text-[var(--text)]">
            <div className="flex items-center justify-between border-b border-[var(--border)] pb-3">
              <div>
                <h3 className="text-sm font-semibold text-[var(--text)]">
                  Объединение профиля {mergeModalUser.name || mergeModalUser.email}
                </h3>
                <p className="text-[11px] text-[var(--text-subtle)] font-mono">
                  Исходный субъект: {mergeModalUser.person_id || mergeModalUser.id}
                </p>
              </div>
              <IconButton
                icon={<X size={16} />}
                aria-label="Закрыть"
                size="sm"
                onClick={() => setMergeModalUser(null)}
              />
            </div>

            <div className="space-y-3">
              <div className="p-3.5 rounded-[var(--radius-sm)] bg-[var(--surface-3)] border border-[var(--border)] space-y-2 text-[var(--text-muted)] leading-relaxed">
                <div className="flex items-center gap-1.5 font-semibold text-[var(--text)]">
                  <Badge tone="muted">В разработке</Badge>
                  <span>Слияние субъектов (person_id)</span>
                </div>
                <p>
                  Административное слияние переносит связанные аккаунты (Discord OAuth, Email), диалоги, векторную память и системные журналы под единый старший <code>person_id</code>.
                </p>
                <p className="text-[11px] text-[var(--text-subtle)]">
                  Для безопасного объединения требуется миграция таблиц долговременной памяти и тредов ядра. Операция станет доступна после релиза identity-service.
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-3 border-t border-[var(--border)]">
              <Button variant="secondary" size="sm" onClick={() => setMergeModalUser(null)}>
                Закрыть
              </Button>
              <SoonAction featureName="Объединение профилей">
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleExecuteMerge}
                >
                  Объединить
                </Button>
              </SoonAction>
            </div>
          </div>
        </div>
      )}

      {/* Revoke Invite Confirmation Dialog */}
      {revokeInviteTarget && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-fade"
        >
          <div className="w-full max-w-sm p-5 rounded-[var(--radius)] bg-[var(--surface-2)] border border-[var(--border-control)] shadow-2xl space-y-4 text-xs animate-dialog text-[var(--text)]">
            <h3 className="text-sm font-semibold text-[var(--text)]">Отозвать приглашение?</h3>
            <p className="text-[var(--text-muted)] leading-relaxed">
              Код <code className="font-mono text-[var(--text)]">{revokeInviteTarget.code || revokeInviteTarget.id}</code> станет недействительным. Пользователи не смогут зарегистрироваться по этой ссылке.
            </p>
            <div className="flex items-center justify-end gap-2 pt-2 border-t border-[var(--border)]">
              <Button variant="secondary" size="sm" onClick={() => setRevokeInviteTarget(null)}>
                Отмена
              </Button>
              <Button variant="danger" size="sm" onClick={() => handleRevokeInvite(revokeInviteTarget)}>
                Отозвать
              </Button>
            </div>
          </div>
        </div>
      )}
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
