'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { User, Sparkles, Brain, Check, ArrowRight } from 'lucide-react';
import { Button, TextField, Switch, Avatar, NeyraLogo } from '../../components/ui';
import { emitToast } from '../../lib/toast';

export default function OnboardingPage() {
  const router = useRouter();
  const [step, setStep] = useState<1 | 2>(1);
  const [displayName, setDisplayName] = useState('NeyraUser');

  // Step 2 toggles
  const [rememberContext, setRememberContext] = useState(true);
  const [syncDiscord, setSyncDiscord] = useState(true);

  const handleNext = () => {
    if (step === 1) {
      setStep(2);
    } else {
      finishOnboarding();
    }
  };

  const handleSkip = () => {
    if (step === 1) {
      setStep(2);
    } else {
      finishOnboarding();
    }
  };

  const finishOnboarding = () => {
    try {
      window.localStorage.setItem('neyra:onboarding-complete', '1');
      window.localStorage.setItem('neyra:remember-context', rememberContext ? '1' : '0');
      window.localStorage.setItem('neyra:sync-discord', syncDiscord ? '1' : '0');
    } catch {}

    emitToast({
      title: 'Добро пожаловать в Neyra!',
      message: 'Профиль успешно настроен. Приятного общения!',
      tone: 'success',
    });
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
                Задайте отображаемое имя и выберите аватар для диалогов и командных каналов.
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
                  Сгенерирован на основе вашего имени
                </div>
                <button
                  type="button"
                  onClick={() => setDisplayName((prev) => (prev.endsWith(' ') ? prev.trim() : prev + ' '))}
                  className="text-xs text-[var(--text)] hover:underline font-medium cursor-pointer pt-0.5 inline-block"
                >
                  Обновить инициалы
                </button>
              </div>
            </div>

            <TextField
              label="Отображаемое имя"
              name="displayName"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Ваше имя или ник"
              hint="Будет использоваться ассистентом в ответах"
            />
          </div>
        )}

        {/* Step 2: Privacy & Memory preferences */}
        {step === 2 && (
          <div className="space-y-5 animate-in fade-in slide-in-from-right-4 duration-150">
            <div className="space-y-1">
              <h1 className="text-lg font-semibold tracking-tight text-[var(--text)]">
                Что помнить?
              </h1>
              <p className="text-xs text-[var(--text-muted)] leading-relaxed">
                Управляйте долговременной памятью и синхронизацией внешних каналов.
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
                    Ассистент сохраняет ключевые факты и предпочтения из бесед для точных ответов.
                  </p>
                </div>
                <Switch
                  checked={rememberContext}
                  onChange={(checked) => setRememberContext(checked)}
                  aria-label="Помнить контекст диалогов"
                />
              </div>

            <div className="p-3.5 rounded-[var(--radius-sm)] bg-[var(--surface-3)] border border-[var(--border)] flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--text)]">
                    <Sparkles size={14} className="text-[var(--text-muted)] shrink-0" />
                    <span>Подтягивать историю Discord</span>
                  </div>
                  <p className="text-[11px] text-[var(--text-subtle)] leading-relaxed">
                    Синхронизирует сообщения и контекст каналов Discord с вашим единым профилем.
                  </p>
                </div>
                <Switch
                  checked={syncDiscord}
                  onChange={(checked) => setSyncDiscord(checked)}
                  aria-label="Подтягивать историю Discord"
                />
              </div>
            </div>

            <p className="text-[11px] text-[var(--text-subtle)] leading-relaxed p-2 rounded bg-[var(--surface)] border border-[var(--border)]">
              Эти параметры можно в любой момент изменить или полностью очистить в разделе <strong>Настройки → Приватность и память</strong>.
            </p>
          </div>
        )}

        {/* Action row */}
        <div className="flex items-center justify-between pt-2 border-t border-[var(--border)]">
          <button
            type="button"
            onClick={handleSkip}
            className="text-xs text-[var(--text-subtle)] hover:text-[var(--text)] transition-colors cursor-pointer py-2 px-1"
          >
            Пропустить
          </button>

          <Button
            type="button"
            variant="primary"
            size="md"
            onClick={handleNext}
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
