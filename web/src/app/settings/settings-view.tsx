'use client';

import React, { useEffect, useState } from 'react';
import { KeyRound, Palette, Volume2, VolumeX } from 'lucide-react';
import { AppSidebar } from '../../components/layout/app-sidebar';
import { isUiSoundsEnabled, playButtonClickSound, setUiSoundsEnabled } from '../../lib/ui-sounds';

export interface SettingsUser {
  id: string;
  name?: string | null;
  email?: string | null;
  role?: string | null;
}

function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-7 w-12 rounded-full border transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)] ${
        checked
          ? 'bg-[var(--accent)] border-[var(--accent)]'
          : 'bg-[var(--surface-3)] border-[var(--border-strong)]'
      }`}
    >
      <span
        className={`absolute top-1 h-5 w-5 rounded-full transition-transform duration-150 ${
          checked
            ? 'translate-x-[22px] bg-[var(--accent-ink)]'
            : 'translate-x-1 bg-[var(--text-muted)]'
        }`}
      />
    </button>
  );
}

function Section({
  icon,
  title,
  description,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]">
      <header className="flex items-start gap-3 border-b border-[var(--border)] px-5 py-4">
        <span className="mt-0.5 text-[var(--text-muted)]">{icon}</span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
          {description && (
            <p className="mt-0.5 text-[11px] leading-relaxed text-[var(--text-subtle)]">{description}</p>
          )}
        </div>
      </header>
      <div className="px-5">{children}</div>
    </section>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-[64px] items-center justify-between gap-4 border-b border-[var(--border)] py-3 last:border-0">
      <div className="min-w-0">
        <p className="text-[13px] text-[var(--text)]">{label}</p>
        {hint && <p className="mt-0.5 text-[11px] leading-relaxed text-[var(--text-subtle)]">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function SettingsView({ user }: { user: SettingsUser }) {
  const [soundsEnabled, setSounds] = useState(true);

  useEffect(() => {
    setSounds(isUiSoundsEnabled());
  }, []);

  function toggleSounds() {
    const next = !soundsEnabled;
    setSounds(next);
    setUiSoundsEnabled(next);
    if (next) playButtonClickSound();
  }

  return (
    <div className="flex h-dvh overflow-hidden bg-[var(--bg)] text-[var(--text)]">
      <AppSidebar activeSection="settings" user={user} />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex h-14 min-h-[56px] shrink-0 items-center border-b border-[var(--border)] bg-[var(--bg)] px-4 pt-[env(safe-area-inset-top)]">
          <h1 className="text-[15px] font-medium tracking-tight">Настройки</h1>
        </header>
        <main className="flex-1 overflow-y-auto px-4 pb-[max(24px,env(safe-area-inset-bottom))] pt-6">
          <div className="mx-auto max-w-2xl space-y-4">
            <Section
              icon={<Palette size={18} />}
              title="Внешний вид"
              description="Тема сайта задаётся дизайн-системой Neyra."
            >
              <Row label="Тема оформления" hint="Тёмная монохромная тема с акцентом на контент.">
                <span className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1 text-[11px] text-[var(--text-muted)]">
                  Тёмная
                </span>
              </Row>
            </Section>

            <Section
              icon={soundsEnabled ? <Volume2 size={18} /> : <VolumeX size={18} />}
              title="Звуки интерфейса"
              description="Тихие микро-щелчки при нажатии кнопок и открытии окон."
            >
              <Row
                label="Звуки"
                hint="Не звучат при вводе текста, прокрутке и при включённом уменьшении движения."
              >
                <Switch checked={soundsEnabled} onChange={() => toggleSounds()} label="Звуки интерфейса" />
              </Row>
            </Section>

            <Section
              icon={<KeyRound size={18} />}
              title="Безопасность"
              description="Доступом управляет администратор Neyra."
            >
              <Row
                label="Смена пароля"
                hint="Администратор выдаёт одноразовую защищённую ссылку сброса."
              >
                <span className="text-[11px] text-[var(--text-subtle)]">через администратора</span>
              </Row>
            </Section>
          </div>
        </main>
      </div>
    </div>
  );
}
