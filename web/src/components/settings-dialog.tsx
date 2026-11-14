'use client';

import React, { useEffect, useRef, useState } from 'react';
import {
  Bell,
  KeyRound,
  Palette,
  Sparkles,
  User,
  X,
  Link2,
  Database,
  AlertTriangle,
  LogOut,
  ShieldCheck,
  Check,
  ExternalLink,
  Laptop,
  Smartphone,
  Trash2,
  Search,
  ArrowRight,
  RotateCcw,
  Volume2,
} from 'lucide-react';
import {
  Avatar,
  IconButton,
  NeyraLogo,
  Button,
  TextField,
  Dialog,
  Badge,
  SoonAction,
} from './ui';
import {
  isUiSoundsEnabled,
  setUiSoundsEnabled,
  playButtonClickSound,
} from '../lib/ui-sounds';
import { emitToast, soonToast } from '../lib/toast';

type SectionId =
  | 'profile'
  | 'accounts'
  | 'appearance'
  | 'notifications'
  | 'privacy'
  | 'data'
  | 'danger';

const SECTIONS: Array<{ id: SectionId; label: string; icon: React.ReactNode }> = [
  { id: 'profile', label: 'Профиль', icon: <User size={15} /> },
  { id: 'accounts', label: 'Аккаунты', icon: <Link2 size={15} /> },
  { id: 'appearance', label: 'Внешний вид', icon: <Palette size={15} /> },
  { id: 'notifications', label: 'Уведомления', icon: <Bell size={15} /> },
  { id: 'privacy', label: 'Приватность и память', icon: <Sparkles size={15} /> },
  { id: 'data', label: 'Данные и сессии', icon: <Database size={15} /> },
  { id: 'danger', label: 'Опасная зона', icon: <AlertTriangle size={15} /> },
];

export interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  user: {
    id?: string;
    person_id?: string;
    email?: string | null;
    name?: string | null;
    role?: string | null;
    discord_id?: string | null;
    discord_username?: string | null;
    platform?: string | null;
  };
  onSignOut?: () => void;
  initialTab?: SectionId;
}

function readFlag(key: string, fallback: boolean): boolean {
  if (typeof window === 'undefined') return fallback;
  const raw = window.localStorage.getItem(key);
  return raw === null ? fallback : raw === '1';
}

function writeFlag(key: string, value: boolean) {
  try {
    window.localStorage.setItem(key, value ? '1' : '0');
  } catch {}
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-[var(--border)] py-3 last:border-0">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-[var(--text)]">{label}</p>
        {hint && (
          <p className="mt-0.5 text-[11px] text-[var(--text-subtle)] leading-relaxed">
            {hint}
          </p>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function SwitchControl({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <div className="flex items-center min-h-[44px]">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => {
          playButtonClickSound();
          onChange(!checked);
        }}
        className={`relative h-6 w-11 rounded-full border transition-colors duration-150 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)] ${
          checked
            ? 'bg-[var(--accent)] border-[var(--accent)]'
            : 'bg-[var(--surface-3)] border-[var(--border-control)] hover:border-[var(--accent)]'
        }`}
      >
        <span
          className={`absolute left-0.5 top-0.5 h-4.5 w-4.5 rounded-full transition-transform duration-150 ${
            checked
              ? 'translate-x-[20px] bg-[var(--accent-ink)]'
              : 'translate-x-0 bg-[var(--text-muted)]'
          }`}
        />
      </button>
    </div>
  );
}

export function SettingsDialog({
  open,
  onClose,
  user,
  onSignOut,
  initialTab = 'profile',
}: SettingsDialogProps) {
  const [section, setSection] = useState<SectionId>(initialTab);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Appearance
  const [particles, setParticles] = useState(true);
  const [cursorRing, setCursorRing] = useState(true);
  const [soundsEnabled, setSounds] = useState(true);
  const [contextMenuNeyra, setContextMenuNeyra] = useState(true);
  const [density, setDensity] = useState<'comfortable' | 'compact'>('comfortable');

  // Privacy & Notifications
  const [rememberContext, setRememberContext] = useState(true);
  const [syncDiscord, setSyncDiscord] = useState(true);
  const [trainOptOut, setTrainOptOut] = useState(true);
  const [browserNotifications, setBrowserNotifications] = useState(false);
  const [responseSound, setResponseSound] = useState(true);

  // Profile Edit
  const [editName, setEditName] = useState(user.name || '');
  const [savingName, setSavingName] = useState(false);
  const [onlyMentions, setOnlyMentions] = useState(true);

  const hasNameChanged = editName.trim() !== (user.name || '').trim() && editName.trim().length > 0;

  const handleSaveProfile = async () => {
    if (!hasNameChanged || savingName) return;
    if (!user.id) {
      soonToast('Сохранение профиля');
      return;
    }
    setSavingName(true);
    try {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(user.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editName.trim() }),
      });
      if (res.ok) {
        emitToast({ message: 'Имя профиля сохранено', tone: 'success' });
      } else {
        const err = await res.json().catch(() => ({}));
        if (res.status === 401 || res.status === 403) {
          soonToast('Сохранение профиля', 'В данный момент доступно администраторам');
        } else {
          emitToast({ message: err.message || 'Не удалось сохранить имя профиля', tone: 'danger' });
        }
      }
    } catch {
      emitToast({ message: 'Ошибка сети при сохранении профиля', tone: 'danger' });
    } finally {
      setSavingName(false);
    }
  };

  // Profile Merge Modal
  const [mergeModalOpen, setMergeModalOpen] = useState(false);

  // Danger Zone
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');

  useEffect(() => {
    if (!open) return;
    setSection(initialTab);
    setParticles(readFlag('neyra:bg-particles', true));
    setCursorRing(readFlag('neyra:cursor-ring', true));
    setSounds(isUiSoundsEnabled());
    setContextMenuNeyra(readFlag('neyra:context-menu-mode-neyra', true));
    setRememberContext(readFlag('neyra:remember-context', true));
    setSyncDiscord(readFlag('neyra:sync-discord', true));
    setEditName(user.name || '');
  }, [open, initialTab, user.name]);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panelRef.current?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !panelRef.current) return;
      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  const personId = user.person_id || user.id || 'u_01HZX87K9W72MQ492XNPR001';

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-3 sm:p-6">
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm animate-fade"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Настройки"
        tabIndex={-1}
        className="relative w-full max-w-[700px] h-[min(580px,90vh)] overflow-hidden rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--surface)] shadow-panel animate-dialog flex flex-col sm:flex-row"
      >
        {/* Left Navigation Column */}
        <nav
          aria-label="Разделы настроек"
          className="sm:w-[220px] shrink-0 border-b sm:border-b-0 sm:border-r border-[var(--border)] bg-[var(--surface-2)] p-2.5 sm:p-3 flex sm:flex-col gap-1 overflow-x-auto sm:overflow-y-auto no-scrollbar scroll-smooth"
        >
          <div className="hidden sm:flex items-center gap-2 px-2 pb-3 text-[13px] font-semibold text-[var(--text)]">
            <NeyraLogo size={20} />
            <span>Настройки</span>
          </div>
          {SECTIONS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                playButtonClickSound();
                setSection(item.id);
              }}
              aria-current={section === item.id ? 'page' : undefined}
              className={`flex shrink-0 items-center gap-2 rounded-[var(--radius-sm)] min-h-[44px] sm:min-h-0 px-3 py-2 text-[13px] text-left transition-colors cursor-pointer select-none ${
                section === item.id
                  ? 'bg-[var(--surface-3)] text-[var(--text)] font-semibold shadow-sm'
                  : 'text-[var(--text-muted)] hover:bg-[var(--surface-3)] hover:text-[var(--text)]'
              }`}
            >
              <span className="text-[var(--text-muted)]">{item.icon}</span>
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        {/* Content Column */}
        <div className="flex-1 min-w-0 flex flex-col bg-[var(--surface)]">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-3">
            <h2 className="text-sm font-semibold">
              {SECTIONS.find((s) => s.id === section)?.label}
            </h2>
            <IconButton
              aria-label="Закрыть"
              tooltip="Закрыть"
              icon={<X size={16} />}
              variant="ghost"
              size="sm"
              onClick={onClose}
            />
          </div>

          {/* Section Body */}
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
            {/* 1. ПРОФИЛЬ */}
            {section === 'profile' && (
              <div className="space-y-4">
                <div className="flex items-center gap-4 pb-4 border-b border-[var(--border)]">
                  <Avatar name={editName || user.email} email={user.email} size={50} />
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="text-[15px] font-semibold text-[var(--text)] truncate">
                      {editName || user.name || 'Пользователь'}
                    </div>
                    <div className="text-xs text-[var(--text-muted)] font-mono truncate">
                      person_id: {personId}
                    </div>
                    <div className="flex items-center gap-2 pt-0.5">
                      <Badge tone="muted">
                        {user.role === 'admin' ? 'Администратор' : 'Пользователь'}
                      </Badge>
                      <button
                        type="button"
                        onClick={() => emitToast({ message: 'Загрузка аватара доступна через привязку Discord', tone: 'info' })}
                        className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text)] underline cursor-pointer"
                      >
                        Сменить аватар
                      </button>
                    </div>
                  </div>
                </div>

                <div className="space-y-3">
                  <TextField
                    label="Имя для обращения"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    placeholder="Как к вам обращаться"
                    hint="Имя, которое ассистент использует в диалогах"
                  />

                  <TextField
                    label="Email"
                    value={user.email || 'Не привязан (вход через Discord)'}
                    disabled
                    hint="Используется для резервного входа. Изменяется администратором."
                  />
                </div>

                <div className="pt-3 border-t border-[var(--border)] flex items-center justify-between">
                  <span className="text-[11px] text-[var(--text-subtle)]">
                    {!hasNameChanged ? 'Нет несохранённых изменений' : 'Есть несохранённые изменения'}
                  </span>
                  <Button
                    type="button"
                    variant="primary"
                    size="md"
                    disabled={!hasNameChanged || savingName}
                    loading={savingName}
                    onClick={() => void handleSaveProfile()}
                  >
                    Сохранить изменения
                  </Button>
                </div>
              </div>
            )}

            {/* 2. АККАУНТЫ (Discord + Web + Merge) */}
            {section === 'accounts' && (() => {
              const isDiscordLinked = Boolean(
                user.discord_id ||
                user.discord_username ||
                user.platform === 'discord' ||
                user.platform === 'both' ||
                (user.email && user.email.endsWith('@discord.placeholder.invalid'))
              );
              const discordTag = user.discord_username || (isDiscordLinked ? 'Подключен' : null);
              const isRealEmail = Boolean(user.email && !user.email.endsWith('@discord.placeholder.invalid'));

              return (
                <div className="space-y-4">
                  <div className="p-3 rounded-[var(--radius-sm)] bg-[var(--surface-2)] border border-[var(--border)] text-xs text-[var(--text-muted)] leading-relaxed">
                    Один профиль Neyra, несколько площадок. История и память общие, удаление профиля удаляет всё.
                  </div>

                  <div className="space-y-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-subtle)]">
                      Привязанные площадки
                    </h3>

                    {/* Discord Account Item */}
                    <div className="p-3 rounded-[var(--radius-sm)] bg-[var(--surface-2)] border border-[var(--border-control)] flex items-center justify-between gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-8 h-8 rounded-full bg-[#5865F2] flex items-center justify-center text-white shrink-0">
                          <Link2 size={16} />
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-semibold text-[var(--text)] truncate">
                              Discord
                            </span>
                            {isDiscordLinked ? (
                              <span className="px-1.5 py-0.2 rounded text-[10px] bg-[var(--surface-3)] text-[var(--text-subtle)]">
                                {isRealEmail ? 'Подключен' : 'Основной'}
                              </span>
                            ) : (
                              <span className="px-1.5 py-0.2 rounded text-[10px] bg-[var(--surface-3)] text-[var(--text-subtle)]">
                                Не привязан
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-[var(--text-muted)] truncate">
                            {isDiscordLinked
                              ? `${discordTag ? `@${discordTag} · ` : ''}синхронизация памяти активна`
                              : 'Не привязан · синхронизация памяти не активна'}
                          </div>
                        </div>
                      </div>
                      {isDiscordLinked ? (
                        <SoonAction featureName="Отвязка Discord" description="Отвязка аккаунта требует подтверждения">
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            disabled={!isRealEmail}
                            title={!isRealEmail ? 'Нельзя отвязать единственный способ входа' : 'Отвязать Discord'}
                            onClick={() => soonToast('Отвязка Discord')}
                          >
                            Отвязать
                          </Button>
                        </SoonAction>
                      ) : (
                        <SoonAction featureName="Привязка Discord" description="Привязка Discord к аккаунту">
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={() => soonToast('Привязка Discord')}
                          >
                            Привязать
                          </Button>
                        </SoonAction>
                      )}
                    </div>

                    {/* Web Account Item */}
                    <div className="p-3 rounded-[var(--radius-sm)] bg-[var(--surface-2)] border border-[var(--border)] flex items-center justify-between gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-8 h-8 rounded-full bg-[var(--surface-3)] border border-[var(--border)] flex items-center justify-center text-[var(--text-muted)] shrink-0">
                          <KeyRound size={16} />
                        </div>
                        <div className="min-w-0">
                          <div className="text-xs font-semibold text-[var(--text)] truncate">
                            Веб-аккаунт (Email)
                          </div>
                          <div className="text-[11px] text-[var(--text-muted)] truncate">
                            {isRealEmail ? user.email : 'Не привязан (вход через Discord)'}
                          </div>
                        </div>
                      </div>
                      {isRealEmail ? (
                        <Badge tone="muted">Подключен</Badge>
                      ) : (
                        <SoonAction featureName="Привязка email" description="Добавить почту и пароль к профилю">
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={() => soonToast('Привязка email')}
                          >
                            Привязать
                          </Button>
                        </SoonAction>
                      )}
                    </div>

                    {/* Future platform stub */}
                    <div className="p-3 rounded-[var(--radius-sm)] bg-[var(--surface-3)]/50 border border-dashed border-[var(--border)] flex items-center justify-between gap-3 opacity-60">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-[var(--surface-2)] border border-[var(--border)] flex items-center justify-center text-[var(--text-subtle)]">
                          <ExternalLink size={14} />
                        </div>
                        <div>
                          <div className="text-xs font-medium text-[var(--text-muted)]">Telegram</div>
                          <div className="text-[10px] text-[var(--text-subtle)]">Площадка в разработке</div>
                        </div>
                      </div>
                      <span className="text-[10px] uppercase font-mono px-2 py-0.5 rounded bg-[var(--surface-2)] text-[var(--text-subtle)]">
                        Скоро
                      </span>
                    </div>
                  </div>

                  {/* Profile Merge Section */}
                  <div className="pt-3 border-t border-[var(--border)] space-y-2">
                    <div className="flex items-center justify-between">
                      <div>
                        <h4 className="text-xs font-semibold text-[var(--text)]">
                          Это не тот профиль?
                        </h4>
                        <p className="text-[11px] text-[var(--text-subtle)] leading-relaxed">
                          Если у вас есть старый профиль Neyra, их можно объединить в один.
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => setMergeModalOpen(true)}
                      >
                        Объединить с другим…
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* 3. ВНЕШНИЙ ВИД */}
            {section === 'appearance' && (
              <div>
                <Row label="Тема оформления" hint="Выбор цветовой палитры интерфейса.">
                  <div className="flex items-center gap-1.5 p-1 bg-[var(--surface-2)] rounded-[var(--radius-sm)] border border-[var(--border)]">
                    <button
                      type="button"
                      className="px-2.5 py-1 text-xs font-medium rounded bg-[var(--surface-3)] text-[var(--text)] shadow-sm cursor-pointer"
                    >
                      Тёмная
                    </button>
                    <SoonAction featureName="Светлая тема" description="Дневной монохромный режим">
                      <button
                        type="button"
                        className="px-2.5 py-1 text-xs font-medium rounded text-[var(--text-subtle)]"
                      >
                        Светлая
                      </button>
                    </SoonAction>
                  </div>
                </Row>

                <Row label="Плотность интерфейса" hint="Интервалы и размер элементов для компактных экранов.">
                  <div className="flex items-center gap-1.5 p-1 bg-[var(--surface-2)] rounded-[var(--radius-sm)] border border-[var(--border)]">
                    <button
                      type="button"
                      onClick={() => setDensity('comfortable')}
                      className={`px-2.5 py-1 text-xs font-medium rounded cursor-pointer ${
                        density === 'comfortable'
                          ? 'bg-[var(--surface-3)] text-[var(--text)] shadow-sm'
                          : 'text-[var(--text-muted)]'
                      }`}
                    >
                      Комфортная
                    </button>
                    <button
                      type="button"
                      onClick={() => setDensity('compact')}
                      className={`px-2.5 py-1 text-xs font-medium rounded cursor-pointer ${
                        density === 'compact'
                          ? 'bg-[var(--surface-3)] text-[var(--text)] shadow-sm'
                          : 'text-[var(--text-muted)]'
                      }`}
                    >
                      Компактная
                    </button>
                  </div>
                </Row>

                <Row
                  label="Звуки интерфейса (громкость 0.25)"
                  hint="Синтез аудиоэффектов при нажатии кнопок, отправке сообщений и открытии окон."
                >
                  <SwitchControl
                    checked={soundsEnabled}
                    label="Звуки интерфейса"
                    onChange={(next) => {
                      setSounds(next);
                      setUiSoundsEnabled(next);
                      emitToast({
                        message: next ? 'Звуки интерфейса включены (громкость 0.25)' : 'Звуки интерфейса отключены',
                        tone: 'info',
                      });
                    }}
                  />
                </Row>

                <Row
                  label="Контекстное меню Neyra"
                  hint="Открывать кастомное меню по правому клику (Shift+ПКМ всегда вызывает системное меню)."
                >
                  <SwitchControl
                    checked={contextMenuNeyra}
                    label="Кастомное контекстное меню"
                    onChange={(next) => {
                      setContextMenuNeyra(next);
                      writeFlag('neyra:context-menu-mode-neyra', next);
                      try {
                        window.localStorage.setItem('neyra:context-menu-mode', next ? 'neyra' : 'system');
                      } catch {}
                    }}
                  />
                </Row>

                <Row label="Фон с частицами" hint="Плавающие светящиеся микрочастицы на холсте диалога.">
                  <SwitchControl
                    checked={particles}
                    label="Фон с частицами"
                    onChange={(next) => {
                      setParticles(next);
                      writeFlag('neyra:bg-particles', next);
                      window.dispatchEvent(new CustomEvent('neyra:appearance'));
                    }}
                  />
                </Row>

                <Row label="Кольцо за курсором" hint="Плавное фокусирующее кольцо, следующее за курсором мыши.">
                  <SwitchControl
                    checked={cursorRing}
                    label="Кольцо за курсором"
                    onChange={(next) => {
                      setCursorRing(next);
                      writeFlag('neyra:cursor-ring', next);
                      window.dispatchEvent(new CustomEvent('neyra:appearance'));
                    }}
                  />
                </Row>
              </div>
            )}

            {/* 4. УВЕДОМЛЕНИЯ */}
            {section === 'notifications' && (
              <div>
                <Row
                  label="Звук завершения ответа"
                  hint="Мягкий сигнал, когда ассистент закончил генерацию сообщения."
                >
                  <SwitchControl
                    checked={responseSound}
                    label="Звук ответа"
                    onChange={setResponseSound}
                  />
                </Row>

                <Row
                  label="Уведомления в браузере"
                  hint="Оповещать об ответах и задачах, когда вкладка находится в фоновом режиме."
                >
                  <SwitchControl
                    checked={browserNotifications}
                    label="Уведомления браузера"
                    onChange={(next) => {
                      setBrowserNotifications(next);
                      if (next && typeof Notification !== 'undefined') {
                        Notification.requestPermission();
                      }
                    }}
                  />
                </Row>

                <Row
                  label="Только важные упоминания"
                  hint="Не присылать уведомления о промежуточных шагах reasoning."
                >
                  <SwitchControl
                    checked={onlyMentions}
                    label="Только упоминания"
                    onChange={setOnlyMentions}
                  />
                </Row>
              </div>
            )}

            {/* 5. ПРИВАТНОСТЬ И ПАМЯТЬ */}
            {section === 'privacy' && (
              <div className="space-y-3">
                <Row
                  label="Помнить контекст диалогов"
                  hint="Ассистент сохраняет факты и предпочтения из бесед для ответов в будущем."
                >
                  <SwitchControl
                    checked={rememberContext}
                    label="Память контекста"
                    onChange={(next) => {
                      setRememberContext(next);
                      writeFlag('neyra:remember-context', next);
                    }}
                  />
                </Row>

                <Row
                  label="Синхронизация истории Discord"
                  hint="Подтягивать историю сообщений из привязанных каналов Discord в общую память."
                >
                  <SwitchControl
                    checked={syncDiscord}
                    label="История Discord"
                    onChange={(next) => {
                      setSyncDiscord(next);
                      writeFlag('neyra:sync-discord', next);
                    }}
                  />
                </Row>

                <Row
                  label="Исключить из обучения моделей"
                  hint="Ваши персональные сообщения и факты не отправляются для дообучения."
                >
                  <SwitchControl
                    checked={trainOptOut}
                    label="Запрет обучения"
                    onChange={setTrainOptOut}
                  />
                </Row>

                <div className="pt-2 border-t border-[var(--border)] flex items-center justify-between">
                  <div>
                    <div className="text-xs font-medium text-[var(--text)]">Очистить долговременную память</div>
                    <div className="text-[11px] text-[var(--text-subtle)]">Удалит извлеченные факты, сохранив переписку</div>
                  </div>
                  <SoonAction featureName="Очистка долговременной памяти" description="Удаление извлеченных фактов из базы ядра">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => soonToast('Очистка долговременной памяти')}
                    >
                      Очистить память
                    </Button>
                  </SoonAction>
                </div>
              </div>
            )}

            {/* 6. ДАННЫЕ И СЕССИИ */}
            {section === 'data' && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-subtle)]">
                    Экспорт
                  </h3>
                  <div className="p-3.5 rounded-[var(--radius-sm)] bg-[var(--surface-2)] border border-[var(--border)] flex items-center justify-between">
                    <div>
                      <div className="text-xs font-medium text-[var(--text)]">Экспорт всех данных</div>
                      <div className="text-[11px] text-[var(--text-subtle)]">Архив диалогов, заметок и настроек в формате JSON / Markdown</div>
                    </div>
                    <SoonAction flag="exportData" featureName="Экспорт профиля">
                      <Button variant="secondary" size="sm">
                        Скачать архив
                      </Button>
                    </SoonAction>
                  </div>
                </div>

                <div className="space-y-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-subtle)]">
                    Активные сессии
                  </h3>

                  {/* Current Session */}
                  <div className="p-3 rounded-[var(--radius-sm)] bg-[var(--surface-2)] border border-[var(--border-control)] flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <Laptop size={16} className="text-[var(--text-muted)] shrink-0" />
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-semibold text-[var(--text)]">Этот браузер</span>
                          <span className="px-1.5 py-0.2 rounded text-[10px] bg-[var(--success)]/20 text-[var(--success)] font-medium">
                            Активна
                          </span>
                        </div>
                        <div className="text-[11px] text-[var(--text-subtle)]">
                          Linux · Chrome · Последняя активность только что
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Second Session Stub */}
                  <div className="p-3 rounded-[var(--radius-sm)] bg-[var(--surface-2)] border border-[var(--border)] flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <Smartphone size={16} className="text-[var(--text-subtle)] shrink-0" />
                      <div>
                        <div className="text-xs font-medium text-[var(--text)]">Neyra Mobile (iOS)</div>
                        <div className="text-[11px] text-[var(--text-subtle)]">Москва · 2 часа назад</div>
                      </div>
                    </div>
                    <SoonAction featureName="Завершение сессии">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => soonToast('Завершение сессии')}
                      >
                        Завершить
                      </Button>
                    </SoonAction>
                  </div>
                </div>

                <div className="pt-2 border-t border-[var(--border)] flex justify-end">
                  <SoonAction featureName="Сброс всех активных сессий">
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => soonToast('Сброс всех активных сессий')}
                    >
                      Выйти на всех устройствах
                    </Button>
                  </SoonAction>
                </div>
              </div>
            )}

            {/* 7. ОПАСНАЯ ЗОНА */}
            {section === 'danger' && (
              <div className="space-y-4">
                <div className="p-3.5 rounded-[var(--radius-sm)] bg-[var(--danger-quiet)] border border-[var(--danger)] text-xs text-[var(--danger)] space-y-1">
                  <div className="font-semibold flex items-center gap-1.5">
                    <AlertTriangle size={15} />
                    <span>Необратимые действия</span>
                  </div>
                  <p className="text-[11px] leading-relaxed">
                    Удаление аккаунта приведет к безвозвратному стиранию диалогов, заметок, памяти и отвязке всех площадок.
                  </p>
                </div>

                <div className="p-3.5 rounded-[var(--radius-sm)] bg-[var(--surface-2)] border border-[var(--border)] flex items-center justify-between gap-3">
                  <div>
                    <div className="text-xs font-semibold text-[var(--text)]">Удалить профиль Neyra</div>
                    <div className="text-[11px] text-[var(--text-subtle)]">Стирает все личные данные и сессии</div>
                  </div>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => setDeleteModalOpen(true)}
                  >
                    Удалить аккаунт…
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Profile Merge Modal */}
      <Dialog
        open={mergeModalOpen}
        onClose={() => setMergeModalOpen(false)}
        title="Объединение профилей Neyra"
        description="Перенос аккаунтов, истории и памяти из второго профиля"
      >
        <div className="space-y-4 text-xs">
          <div className="p-3.5 rounded-[var(--radius-sm)] bg-[var(--surface-2)] border border-[var(--border)] space-y-2 text-[var(--text-muted)] leading-relaxed">
            <div className="flex items-center gap-1.5 font-semibold text-[var(--text)]">
              <Badge tone="muted">В разработке</Badge>
              <span>Объединение профилей (person_id)</span>
            </div>
            <p>
              Слияние профилей позволяет перенести историю диалогов, привязанные площадки (Discord/Web) и векторную память в один аккаунт.
            </p>
            <p className="text-[11px] text-[var(--text-subtle)]">
              Для безопасного переноса требуется миграция таблиц долговременной памяти и тредов ядра. Функция станет доступна после релиза identity-сервиса.
            </p>
          </div>

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-[var(--border)]">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setMergeModalOpen(false)}
            >
              Закрыть
            </Button>
            <SoonAction featureName="Объединение профилей">
              <Button
                variant="primary"
                size="sm"
                onClick={() => soonToast('Объединение профилей')}
              >
                Объединить
              </Button>
            </SoonAction>
          </div>
        </div>
      </Dialog>

      {/* Delete Account Modal */}
      <Dialog
        open={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        title="Удаление профиля"
        description="Это действие сотрет все данные без возможности восстановления"
      >
        <div className="space-y-4 text-xs">
          <p className="text-[var(--danger)] font-medium">
            Внимание! Все диалоги, память и связи с Discord будут безвозвратно удалены.
          </p>
          <TextField
            label='Для подтверждения введите "удалить":'
            value={deleteConfirmText}
            onChange={(e) => setDeleteConfirmText(e.target.value)}
            placeholder="удалить"
          />
          <div className="flex items-center justify-end gap-2 pt-2 border-t border-[var(--border)]">
            <Button variant="secondary" size="sm" onClick={() => setDeleteModalOpen(false)}>
              Отмена
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={deleteConfirmText.trim().toLowerCase() !== 'удалить'}
              onClick={() => {
                setDeleteModalOpen(false);
                onClose();
                onSignOut?.();
              }}
            >
              Удалить навсегда
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
