'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, KeyRound, Palette, Volume2, VolumeX } from 'lucide-react';
import { Button, NeyraLogo } from '../../components/ui';
import { isUiSoundsEnabled, setUiSoundsEnabled } from '../../lib/ui-sounds';

export default function SettingsPage() {
  const [soundsEnabled, setSounds] = useState(true);

  useEffect(() => {
    setSounds(isUiSoundsEnabled());
  }, []);

  function toggleSounds() {
    const next = !soundsEnabled;
    setSounds(next);
    setUiSoundsEnabled(next);
  }

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <header className="h-14 border-b border-[var(--border)] px-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link
            href="/chat"
            className="inline-flex items-center gap-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text)] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)] rounded-[var(--radius-sm)] px-1 py-0.5"
          >
            <ArrowLeft size={14} />
            <span>К чату</span>
          </Link>
          <span className="text-xs text-[var(--text-subtle)]">/</span>
          <h1 className="text-sm font-semibold tracking-tight">Настройки</h1>
        </div>
        <Link href="/" className="flex items-center gap-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)] rounded-[var(--radius-sm)] px-1 py-0.5">
          <NeyraLogo size={22} />
          <span className="text-sm font-semibold">Neyra</span>
        </Link>
      </header>

      <main className="content-column py-8 space-y-6 max-w-2xl mx-auto px-4">
        {/* Внешний вид */}
        <section className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5 space-y-4">
          <div className="flex items-center gap-2.5 pb-3 border-b border-[var(--border)]">
            <Palette size={18} className="text-[var(--text-muted)]" />
            <h2 className="text-sm font-semibold">Внешний вид</h2>
          </div>
          <div className="text-xs text-[var(--text-muted)] flex justify-between items-center">
            <span>Тема оформления</span>
            <span className="font-mono text-[var(--text)] bg-[var(--surface-2)] px-2.5 py-1 rounded-[var(--radius-sm)] border border-[var(--border)]">
              Тёмная (монохром)
            </span>
          </div>
        </section>

        {/* Звуки интерфейса */}
        <section className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5 space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-[var(--border)]">
            <div className="flex items-center gap-2.5">
              {soundsEnabled ? (
                <Volume2 size={18} className="text-[var(--text-muted)]" />
              ) : (
                <VolumeX size={18} className="text-[var(--text-subtle)]" />
              )}
              <div>
                <h2 className="text-sm font-semibold">Звуки интерфейса</h2>
                <p className="text-[11px] text-[var(--text-subtle)] mt-0.5">
                  Тихие микро-щелчки WebAudio при нажатии кнопок и открытии окон.
                </p>
              </div>
            </div>
            <Button
              variant={soundsEnabled ? 'primary' : 'secondary'}
              size="sm"
              onClick={toggleSounds}
              aria-pressed={soundsEnabled}
            >
              {soundsEnabled ? 'Включены' : 'Выключены'}
            </Button>
          </div>
          <div className="text-xs text-[var(--text-muted)]">
            Звуки не воспроизводятся при вводе текста, прокрутке и при включённом режиме уменьшения движения.
          </div>
        </section>

        {/* Безопасность */}
        <section className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5 space-y-4">
          <div className="flex items-center gap-2.5 pb-3 border-b border-[var(--border)]">
            <KeyRound size={18} className="text-[var(--text-muted)]" />
            <h2 className="text-sm font-semibold">Безопасность</h2>
          </div>
          <p className="text-xs text-[var(--text-muted)] leading-relaxed">
            Смена пароля и управление доступом осуществляются администратором через разовые защищённые ссылки сброса.
          </p>
        </section>
      </main>
    </div>
  );
}
