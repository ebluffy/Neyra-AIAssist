'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Bell, BookOpen, KeyRound, Mic, Palette, Sparkles, User, X } from 'lucide-react';
import { IconButton, NeyraLogo } from './ui';

type SectionId = 'profile' | 'appearance' | 'notifications' | 'voice' | 'library' | 'memory' | 'security';

const SECTIONS: Array<{ id: SectionId; label: string; icon: React.ReactNode; soon?: boolean }> = [
  { id: 'profile', label: 'Профиль', icon: <User size={15} /> },
  { id: 'appearance', label: 'Внешний вид', icon: <Palette size={15} /> },
  { id: 'notifications', label: 'Уведомления', icon: <Bell size={15} />, soon: true },
  { id: 'voice', label: 'Голос', icon: <Mic size={15} />, soon: true },
  { id: 'library', label: 'Библиотека', icon: <BookOpen size={15} />, soon: true },
  { id: 'memory', label: 'Память', icon: <Sparkles size={15} />, soon: true },
  { id: 'security', label: 'Безопасность', icon: <KeyRound size={15} /> },
];

export interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  user: { email?: string | null; name?: string | null; role?: string | null };
  onSignOut?: () => void;
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

function SoonBadge() {
  return (
    <span className="ml-1.5 rounded-full border border-[var(--border)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--text-subtle)]">
      soon
    </span>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-[var(--border)] py-3 last:border-0">
      <div className="min-w-0">
        <p className="text-[13px] text-[var(--text)]">{label}</p>
        {hint && <p className="mt-0.5 text-[11px] text-[var(--text-subtle)] leading-relaxed">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (next: boolean) => void; label: string }) {
  return (
    <div className="flex items-center min-h-[44px]">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative h-6 w-11 rounded-full border transition-colors duration-150 cursor-pointer ${
          checked ? 'bg-[var(--accent)] border-[var(--accent)]' : 'bg-[var(--surface-3)] border-[var(--border-strong)]'
        }`}
      >
        <span
          className={`absolute left-0.5 top-0.5 h-4.5 w-4.5 rounded-full transition-transform duration-150 ${
            checked ? 'translate-x-[20px] bg-[var(--accent-ink)]' : 'translate-x-0 bg-[var(--text-muted)]'
          }`}
        />
      </button>
    </div>
  );
}

export function SettingsDialog({ open, onClose, user, onSignOut }: SettingsDialogProps) {
  const [section, setSection] = useState<SectionId>('profile');
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [particles, setParticles] = useState(true);
  const [cursorRing, setCursorRing] = useState(true);

  useEffect(() => {
    if (!open) return;
    setParticles(readFlag('neyra:bg-particles', true));
    setCursorRing(readFlag('neyra:cursor-ring', true));
  }, [open]);

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
      // Фокус не уходит за пределы диалога.
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

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-3 sm:p-6">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm animate-fade" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Настройки"
        tabIndex={-1}
        className="relative w-full max-w-[880px] h-[min(640px,88vh)] overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-strong)] bg-[var(--surface)] shadow-panel animate-dialog flex flex-col sm:flex-row"
      >
        {/* Левая навигация */}
        <nav className="sm:w-[220px] shrink-0 border-b sm:border-b-0 sm:border-r border-[var(--border)] bg-[var(--surface-2)] p-3 flex sm:flex-col gap-1 overflow-x-auto sm:overflow-y-auto">
          <div className="hidden sm:flex items-center gap-2 px-2 pb-3 text-[13px] font-semibold text-[var(--text)]">
            <NeyraLogo size={20} />
            <span>Настройки</span>
          </div>
          {SECTIONS.map(item => (
            <button
              key={item.id}
              type="button"
              onClick={() => setSection(item.id)}
              aria-current={section === item.id ? 'page' : undefined}
              className={`flex shrink-0 items-center gap-2 rounded-[var(--radius-sm)] min-h-[44px] sm:min-h-0 px-3 py-2 text-[13px] text-left transition-colors cursor-pointer select-none ${
                section === item.id
                  ? 'bg-[var(--surface-3)] text-[var(--text)] font-semibold shadow-sm border border-[var(--border-strong)] sm:border-0'
                  : 'text-[var(--text-muted)] hover:bg-[var(--surface-3)] hover:text-[var(--text)]'
              }`}
            >
              <span className="text-[var(--text-muted)]">{item.icon}</span>
              <span>{item.label}</span>
              {item.soon && <SoonBadge />}
            </button>
          ))}
        </nav>

        {/* Контент */}
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2.5">
            <h2 className="text-[13px] font-semibold">{SECTIONS.find(s => s.id === section)?.label}</h2>
            <IconButton aria-label="Закрыть" tooltip="Закрыть" icon={<X size={16} />} variant="ghost" size="sm" onClick={onClose} />
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-3">
            {section === 'profile' && (
              <div>
                <Row label="Email" hint="Логин на сайте. Меняется администратором.">
                  <span className="text-[13px] text-[var(--text-muted)]">{user.email ?? '—'}</span>
                </Row>
                <Row label="Имя" hint="Как тебя называет Нейра в диалоге.">
                  <span className="text-[13px] text-[var(--text-muted)]">{user.name || 'не задано'}</span>
                </Row>
                <Row label="Роль">
                  <span className="text-[13px] text-[var(--text-muted)]">{user.role === 'admin' ? 'администратор' : 'пользователь'}</span>
                </Row>
                <Row label="Выйти из аккаунта">
                  <button
                    type="button"
                    onClick={() => { onClose(); onSignOut?.(); }}
                    className="min-h-[44px] sm:min-h-0 flex items-center justify-center rounded-[var(--radius-sm)] border border-[var(--border-strong)] px-3.5 py-1.5 text-[12px] font-medium text-[var(--danger)] hover:bg-[var(--danger-quiet)] transition-colors cursor-pointer"
                  >
                    Выйти
                  </button>
                </Row>
              </div>
            )}

            {section === 'appearance' && (
              <div>
                <Row label="Тема" hint="Монохромная тёмная — единственная в этой сборке.">
                  <span className="text-[12px] text-[var(--text-muted)]">Тёмная</span>
                </Row>
                <Row label="Фон с точками" hint="Редкие плывущие точки на фоне чата.">
                  <Switch
                    checked={particles}
                    label="Фон с точками"
                    onChange={next => {
                      setParticles(next);
                      writeFlag('neyra:bg-particles', next);
                      window.dispatchEvent(new CustomEvent('neyra:appearance'));
                    }}
                  />
                </Row>
                <Row label="Кольцо за курсором" hint="Тонкий круг, который следует за указателем. На тач-устройствах не показывается.">
                  <Switch
                    checked={cursorRing}
                    label="Кольцо за курсором"
                    onChange={next => {
                      setCursorRing(next);
                      writeFlag('neyra:cursor-ring', next);
                      window.dispatchEvent(new CustomEvent('neyra:appearance'));
                    }}
                  />
                </Row>
                <Row label="Плотность" hint="Компактный режим для больших экранов.">
                  <span className="text-[12px] text-[var(--text-subtle)]">скоро</span>
                </Row>
              </div>
            )}

            {section === 'notifications' && (
              <div>
                <Row label="Звук ответа" hint="Короткий сигнал, когда Нейра закончила.">
                  <span className="text-[12px] text-[var(--text-subtle)]">скоро</span>
                </Row>
                <Row label="Уведомления браузера" hint="Показывать ответ, если вкладка свёрнута.">
                  <span className="text-[12px] text-[var(--text-subtle)]">скоро</span>
                </Row>
              </div>
            )}

            {section === 'voice' && (
              <div>
                <Row label="Голосовой режим" hint="Разговор с Нейрой в реальном времени: микрофон, распознавание, ответ голосом.">
                  <span className="text-[12px] text-[var(--text-subtle)]">скоро</span>
                </Row>
                <Row label="Голос ассистента" hint="Выбор тембра озвучки.">
                  <span className="text-[12px] text-[var(--text-subtle)]">скоро</span>
                </Row>
              </div>
            )}

            {section === 'library' && (
              <div>
                <Row label="Вложения диалога" hint="Все файлы, которые ты прикреплял в этом чате, будут собираться здесь.">
                  <span className="text-[12px] text-[var(--text-subtle)]">скоро</span>
                </Row>
                <Row label="Файлы Нейры" hint="Что она присылала в ответ.">
                  <span className="text-[12px] text-[var(--text-subtle)]">скоро</span>
                </Row>
              </div>
            )}

            {section === 'memory' && (
              <div>
                <Row label="Что Нейра помнит" hint="Сводка по твоим фактам и дневнику придёт из ядра.">
                  <span className="text-[12px] text-[var(--text-subtle)]">скоро</span>
                </Row>
                <Row label="Очистить контекст" hint="Начать диалог с чистого контекста, не удаляя память.">
                  <span className="text-[12px] text-[var(--text-subtle)]">скоро</span>
                </Row>
              </div>
            )}

            {section === 'security' && (
              <div>
                <Row label="Пароль" hint="Смена пароля — через администратора: он выдаёт одноразовую ссылку.">
                  <span className="text-[12px] text-[var(--text-subtle)]">через админа</span>
                </Row>
                <Row label="Вход через Discord" hint="Привязывается по совпадению email при первом входе.">
                  <span className="text-[12px] text-[var(--text-subtle)]">по email</span>
                </Row>
                <Row label="Завершить все сессии" hint="Сбросить вход на всех устройствах.">
                  <span className="text-[12px] text-[var(--text-subtle)]">скоро</span>
                </Row>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
