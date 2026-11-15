'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Sparkles, Brain, Check, ArrowRight } from 'lucide-react';
import { Button, TextField, Switch, Avatar, NeyraLogo, SoonAction } from '../../components/ui';
import { emitToast } from '../../lib/toast';

export default function OnboardingPage() {
  const router = useRouter();
  const [step, setStep] = useState<1 | 2>(1);
  const [displayName, setDisplayName] = useState('');
  const [saving, setSaving] = useState(false);

  // AR-72: переключатели памяти пока не имеют серверной ручки, поэтому они
  // только показывают будущие настройки и ничего не сохраняют.
  const [rememberContext] = useState(true);
  const [syncDiscord] = useState(true);

  const handleNext = () => {
    if (step === 1) {
      setStep(2);
    } else {
      void finishOnboarding();
    }
  };

  const finishOnboarding = async () => {
    if (saving) return;
    const name = displayName.trim();
    let saved = false;
    setSaving(true);
    if (name) {
      try {
        // AR-74: имя сохраняется настоящей ручкой профиля, а не в localStorage.
        const res = await fetch('/api/me', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        saved = res.ok;
      } catch {
        saved = false;
      }
    }
    setSaving(false);
    try {
      window.localStorage.setItem('neyra:onboarding-complete', '1');
    } catch {}

    if (name) {
      emitToast(
        saved
          ? {
              title: 'Имя сохранено',
              message: 'Изменить его можно в настройках профиля.',
              tone: 'success',
            }
          : {
              title: 'Имя не сохранено',
              message: 'Сервер не принял имя. Задайте его позже в настройках профиля.',
              tone: 'danger',
            },
      );
    } else {
      emitToast({
        title: 'Добро пожаловать в Neyra!',
        message: 'Имя не задано — его можно указать позже в настройках профиля.',
        tone: 'info',
      });
    }
    router.replace('/chat');
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 sm:p-6 bg-[var(--surface)] text-[var(--text)]">
      <main className="w-full max-w-[420px] p-6 sm:p-8 rounded-[var(--radius)] bg-[var(--surface-2)] border border-[var(--border-control)] space-y-6 shadow-xl animate-in fade-in duration-150">
        {/* Progress indicator */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <NeyraLogo size={24} />
            <span className="text-xs font-semibold tracking-tight text-[var(--text)]">Neyra</span>
          </div>
          <div className="text-[11px] font-mono text-[var(--text-subtle)]">
            Шаг {step} из 2
          </div>
        </div>

        {/* Step 1: Profile & Greeting */}
        {step === 1 && (
          <div className="space-y-5 animate-in fade-in slide-in-from-right-4 duration-150">
            <div className="space-y-1">
              <h1 className="text-lg font-semibold tracking-tight text-[var(--text)]">
                Как к тебе обращаться?
              </h1>
              <p className="text-xs text-[var(--text-muted)] leading-relaxed">
                Имя можно не указывать: тогда его зададите позже в настройках профиля.
              </p>
            </div>

            {/* Avatar section */}
            <div className="flex items-center gap-4 p-3 rounded-[var(--radius-sm)] bg-[var(--surface-3)] border border-[var(--border)]">
              <Avatar
                name={displayName}
                size={54}
                className="text-base ring-2 ring-[var(--border-control)]"
              />
              <div className="flex-1 space-y-1">
                <div className="text-xs font-medium text-[var(--text)]">Аватар профиля</div>
                <div className="text-[11px] text-[var(--text-subtle)]">
                  Инициалы берутся из имени, которое вы введёте
                </div>
              </div>
            </div>

            <TextField
              label="Отображаемое имя"
              name="displayName"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Ваше имя или ник"
              hint="Сохранится в профиле; можно изменить в настройках"
            />
          </div>
        )}

        {/* Step 2: Privacy & Memory preferences */}
        {step === 2 && (
          <div className="space-y-5 animate-in fade-in slide-in-from-right-4 duration-150">
            <div className="space-y-1">
              <h1 className="text-lg font-semibold tracking-tight text-[var(--text)]">
                Память и каналы
              </h1>
              <p className="text-xs text-[var(--text-muted)] leading-relaxed">
                Эти настройки появятся позже: серверных ручек управления памятью пока нет.
              </p>
            </div>

            <div className="space-y-3">
              <div className="p-3.5 rounded-[var(--radius-sm)] bg-[var(--surface-3)] border border-[var(--border)] flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--text)]">
                    <Brain size={14} className="text-[var(--text-muted)] shrink-0" />
                    <span>Помнить контекст диалогов</span>
                  </div>
                  <p className="text-[11px] text-[var(--text-subtle)] leading-relaxed">
                    Появится вместе с серверной ручкой памяти. Сейчас переключатель ничего не меняет.
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <SoonAction
                    featureName="Память контекста"
                    description="Управление памятью из веба появится вместе с серверной ручкой"
                  >
                    <button
                      type="button"
                      className="rounded-[var(--radius-sm)] border border-[var(--border)] px-2 py-0.5 text-[10px] font-medium text-[var(--text-subtle)] hover:text-[var(--text)]"
                    >
                      Скоро
                    </button>
                  </SoonAction>
                  <Switch
                    checked={rememberContext}
                    onChange={() => {}}
                    disabled
                    aria-label="Помнить контекст диалогов"
                  />
                </div>
              </div>

              <div className="p-3.5 rounded-[var(--radius-sm)] bg-[var(--surface-3)] border border-[var(--border)] flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--text)]">
                    <Sparkles size={14} className="text-[var(--text-muted)] shrink-0" />
                    <span>Подтягивать историю Discord</span>
                  </div>
                  <p className="text-[11px] text-[var(--text-subtle)] leading-relaxed">
                    Появится вместе с серверной ручкой истории. Сейчас переключатель ничего не меняет.
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <SoonAction
                    featureName="История Discord"
                    description="Синхронизация истории каналов появится вместе с серверной ручкой"
                  >
                    <button
                      type="button"
                      className="rounded-[var(--radius-sm)] border border-[var(--border)] px-2 py-0.5 text-[10px] font-medium text-[var(--text-subtle)] hover:text-[var(--text)]"
                    >
                      Скоро
                    </button>
                  </SoonAction>
                  <Switch
                    checked={syncDiscord}
                    onChange={() => {}}
                    disabled
                    aria-label="Подтягивать историю Discord"
                  />
                </div>
              </div>
            </div>

            <p className="text-[11px] text-[var(--text-subtle)] leading-relaxed p-2 rounded bg-[var(--surface)] border border-[var(--border)]">
              Когда появятся серверные настройки, их можно будет изменить в разделе{' '}
              <strong>Настройки → Приватность и память</strong>.
            </p>
          </div>
        )}

        {/* Action row */}
        <div className="flex items-center justify-between pt-2 border-t border-[var(--border)]">
          <button
            type="button"
            onClick={handleNext}
            className="text-xs text-[var(--text-subtle)] hover:text-[var(--text)] transition-colors cursor-pointer py-2 px-1"
          >
            Пропустить
          </button>

          <Button
            type="button"
            variant="primary"
            size="md"
            onClick={handleNext}
            loading={saving}
            className="h-10 min-h-[40px] px-4 gap-1.5 text-xs font-medium"
          >
            <span>{step === 1 ? 'Далее' : 'Завершить настройку'}</span>
            {step === 1 ? <ArrowRight size={14} /> : <Check size={14} />}
          </Button>
        </div>
      </main>
    </div>
  );
}
