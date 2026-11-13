'use client';

import React, { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Check } from 'lucide-react';
import { Button, TextField, NeyraLogo } from './ui';
import { signIn, signUp } from '../../lib/auth-client';
import { credentialsSchema, authErrorText } from '../../lib/auth-policy';
import { ru } from '../i18n';

export function AuthForm({ mode }: { mode: 'login' | 'signup' }) {
  const router = useRouter();
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    const form = new FormData(event.currentTarget);
    const email = form.get('email');
    const password = form.get('password');

    const parsed = credentialsSchema.safeParse({ email, password });
    if (!parsed.success) {
      const issues = parsed.error.issues;
      const errors: { email?: string; password?: string } = {};
      for (const issue of issues) {
        if (issue.path[0] === 'email' && !errors.email) errors.email = issue.message;
        if (issue.path[0] === 'password' && !errors.password) errors.password = issue.message;
      }
      setFieldErrors(errors);
      setError(issues[0]?.message || 'Проверьте введённые данные.');
      return;
    }

    setFieldErrors({});
    setError('');
    setPending(true);

    try {
      const result =
        mode === 'signup'
          ? await signUp.email({ ...parsed.data, name: parsed.data.email })
          : await signIn.email(parsed.data);

      if (result.error) {
        setError(authErrorText(result.error.code));
        return;
      }
      router.replace('/');
      router.refresh();
    } catch {
      setError(ru.networkError);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col lg:flex-row w-full bg-[var(--bg)] text-[var(--text)]">
      {/* Left hero column (>= 1024px) (§4) */}
      <div
        className="hidden lg:flex lg:w-[45%] flex-col justify-between p-12 border-r border-[var(--border)] relative bg-[var(--bg)] select-none"
        style={{
          backgroundImage:
            'linear-gradient(to right, rgba(255,255,255,0.04) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.04) 1px, transparent 1px)',
          backgroundSize: '96px 96px',
        }}
      >
        <div className="flex items-center gap-3">
          <NeyraLogo size={32} />
          <span className="text-[22px] font-semibold tracking-tight text-[var(--text)]">Neyra</span>
        </div>

        <div className="max-w-[420px] my-auto space-y-8">
          <div>
            <h2 className="text-[28px] font-semibold tracking-tight text-[var(--text)] leading-tight">
              Интеллектуальный ассистент
            </h2>
            <p className="text-[15px] leading-relaxed text-[var(--text-muted)] mt-2">
              Локальный AI-компаньон с долгосрочной памятью диалогов и строгим контролем приватности.
            </p>
          </div>

          <div className="space-y-4 pt-2">
            <div className="flex items-start gap-3">
              <div className="w-5 h-5 rounded-full bg-[var(--accent-quiet)] flex items-center justify-center shrink-0 mt-0.5">
                <Check size={13} className="text-[var(--accent)]" />
              </div>
              <span className="text-[13px] text-[var(--text)] leading-relaxed">
                Свой сервер и полная независимость данных
              </span>
            </div>

            <div className="flex items-start gap-3">
              <div className="w-5 h-5 rounded-full bg-[var(--accent-quiet)] flex items-center justify-center shrink-0 mt-0.5">
                <Check size={13} className="text-[var(--accent)]" />
              </div>
              <span className="text-[13px] text-[var(--text)] leading-relaxed">
                Долгосрочная память контекста и истории диалогов
              </span>
            </div>

            <div className="flex items-start gap-3">
              <div className="w-5 h-5 rounded-full bg-[var(--accent-quiet)] flex items-center justify-center shrink-0 mt-0.5">
                <Check size={13} className="text-[var(--accent)]" />
              </div>
              <span className="text-[13px] text-[var(--text)] leading-relaxed">
                Строгое разграничение ролей и аутентификация сессий
              </span>
            </div>
          </div>
        </div>

        <div className="text-xs text-[var(--text-subtle)]">
          Версия платформы 2.0 · Безопасный контур
        </div>
      </div>

      {/* Right card column (§4) */}
      <div className="flex-1 flex flex-col items-center justify-center p-6 md:p-12 bg-[var(--surface)] min-h-screen lg:min-h-0">
        {/* Mobile branding header (< 1024px) */}
        <div className="flex lg:hidden items-center gap-2.5 mb-8">
          <NeyraLogo size={32} />
          <span className="text-[20px] font-semibold tracking-tight text-[var(--text)]">Neyra</span>
        </div>

        {/* 360px centered card (§4) */}
        <main className="w-full max-w-[360px] space-y-6">
          <div>
            <h1 className="text-[22px] font-semibold tracking-tight text-[var(--text)]">
              {mode === 'login' ? ru.login : ru.signup}
            </h1>
            <p className="text-[13px] text-[var(--text-muted)] mt-1">
              {mode === 'login' ? 'Введите email и пароль для продолжения' : 'Создайте новый аккаунт для доступа'}
            </p>
          </div>

          {error && (
            <div
              role="alert"
              className="rounded-[var(--radius)] border border-[var(--danger)] bg-[var(--danger-quiet)] p-3 text-xs text-[var(--danger)]"
            >
              {error}
            </div>
          )}

          <form onSubmit={submit} className="space-y-4" aria-busy={pending} noValidate>
            <TextField
              label={ru.email}
              name="email"
              type="email"
              autoComplete="email"
              required
              disabled={pending}
              placeholder="name@example.com"
              error={fieldErrors.email}
            />

            <TextField
              label={ru.password}
              name="password"
              type="password"
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              minLength={10}
              maxLength={128}
              required
              disabled={pending}
              placeholder="••••••••••"
              error={fieldErrors.password}
              hint={mode === 'signup' ? 'Не менее 10 символов' : undefined}
            />

            <Button type="submit" variant="primary" size="lg" loading={pending} className="w-full mt-2">
              {pending ? ru.wait : mode === 'login' ? ru.submit : ru.register}
            </Button>
          </form>

          <div className="text-center pt-2">
            <span className="text-[13px] text-[var(--text-muted)]">
              {mode === 'login' ? 'Нет аккаунта? ' : 'Уже есть аккаунт? '}
            </span>
            <Link
              href={mode === 'login' ? '/signup' : '/login'}
              className="text-[13px] text-[var(--accent)] font-medium hover:underline underline-offset-[3px] transition-all"
            >
              {mode === 'login' ? ru.signup : ru.login}
            </Link>
          </div>
        </main>
      </div>
    </div>
  );
}
