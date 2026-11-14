'use client';

import React, { useState, useEffect, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  CheckCircle2,
  Ticket,
  ChevronDown,
  HelpCircle,
  ShieldCheck,
  Activity,
  AlertCircle,
} from 'lucide-react';
import { Button, PasswordField, TextField, NeyraLogo } from './ui';
import { signIn, signUp } from '../../lib/auth-client';
import { credentialsSchema, authErrorText } from '../../lib/auth-policy';
import type { AuthConfig } from '../../lib/env';
import type { RegistrationMode } from '../../lib/registration-mode';
import { ru } from '../i18n';
import { emitToast } from '../lib/toast';

function DiscordIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994.021-.041.001-.09-.041-.106a13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.929 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.894.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
    </svg>
  );
}

export interface AuthFormProps {
  mode: 'login' | 'signup';
  config?: AuthConfig;
  initialError?: string;
  invite?: string;
  registrationMode?: RegistrationMode;
}

export function AuthForm({
  mode,
  config,
  initialError = '',
  invite = '',
  registrationMode,
}: AuthFormProps) {
  const router = useRouter();
  const [error, setError] = useState(initialError);
  const [fieldErrors, setFieldErrors] = useState<{
    email?: string;
    password?: string;
    inviteCode?: string;
  }>({});
  const [pending, setPending] = useState(false);
  const [discordPending, setDiscordPending] = useState(false);
  const [inviteCode, setInviteCode] = useState(invite);

  // By default, if discord is available, email form starts collapsed unless password-only mode or in signup
  const [showEmailForm, setShowEmailForm] = useState(
    config?.authMode === 'password' || mode === 'signup'
  );
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const mockErr = params.get('mockError');
    if (mockErr === '429') {
      setError('Слишком много попыток. Пожалуйста, подождите 15 минут.');
      setShowEmailForm(true);
    } else if (mockErr === 'invalid') {
      setError('Неверный адрес почты или пароль.');
      setShowEmailForm(true);
    } else if (mockErr === 'expired') {
      setError('Срок действия приглашения истёк.');
    } else if (mockErr === 'used') {
      setError('Недействительный или уже использованный код приглашения.');
    } else if (mockErr === 'oauth') {
      setError('Ошибка авторизации через Discord. Повторите попытку.');
    }
    const urlInvite = params.get('invite');
    if (urlInvite) {
      setInviteCode(urlInvite);
    }
  }, []);

  const authMode = config?.authMode ?? 'both';
  const inviteRequired = registrationMode
    ? registrationMode === 'invite'
    : (config?.inviteRequired ?? false);
  const discordAvailable = config?.discordAvailable ?? true;
  const showDiscord = discordAvailable && authMode !== 'password';

  const hasAppliedInvite =
    !!invite ||
    (typeof window !== 'undefined' &&
      !!new URLSearchParams(window.location.search).get('invite'));

  async function handleDiscordSignIn() {
    if (discordPending) return;
    setDiscordPending(true);
    setError('');

    // If invite is required and code not entered
    if (inviteRequired && !inviteCode.trim()) {
      setError('Для входа требуется код приглашения. Введите код ниже.');
      setDiscordPending(false);
      return;
    }

    try {
      // Simulate or call Discord OAuth provider
      await signIn.social({
        provider: 'discord',
        callbackURL: '/onboarding',
      });
    } catch {
      setError('Не удалось подключиться к Discord. Попробуйте позже.');
      setDiscordPending(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    const form = new FormData(event.currentTarget);
    const email = form.get('email');
    const password = form.get('password');

    const parsedCreds = credentialsSchema.safeParse({ email, password });
    const nextFieldErrors: { email?: string; password?: string; inviteCode?: string } = {};

    if (!parsedCreds.success) {
      for (const issue of parsedCreds.error.issues) {
        if (issue.path[0] === 'email' && !nextFieldErrors.email)
          nextFieldErrors.email = issue.message;
        if (issue.path[0] === 'password' && !nextFieldErrors.password)
          nextFieldErrors.password = issue.message;
      }
    }

    const token = inviteCode.trim();
    if (inviteRequired && !hasAppliedInvite && !token) {
      nextFieldErrors.inviteCode = ru.inviteRequired;
    }

    if (Object.keys(nextFieldErrors).length > 0) {
      setFieldErrors(nextFieldErrors);
      const firstMsg =
        nextFieldErrors.email ||
        nextFieldErrors.password ||
        nextFieldErrors.inviteCode ||
        'Проверьте введённые данные.';
      setError(firstMsg);
      return;
    }

    if (!parsedCreds.success) return;

    setFieldErrors({});
    setError('');
    setPending(true);

    try {
      const result =
        mode === 'signup'
          ? await signUp.email({
              ...parsedCreds.data,
              name: parsedCreds.data.email,
              invite: token,
            } as Parameters<typeof signUp.email>[0])
          : await signIn.email(parsedCreds.data);

      if (result?.error) {
        setError(authErrorText(result.error.code, result.error.message));
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
    <div className="min-h-screen flex flex-col items-center justify-center p-4 sm:p-6 bg-[var(--surface)] text-[var(--text)]">
      {/* Centered card 380px */}
      <main className="w-full max-w-[380px] space-y-5">
        {/* Logo and product description header */}
        <div className="flex flex-col items-center text-center gap-2 mb-2">
          <Link href="/" className="inline-flex items-center gap-2 p-1 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)] rounded-[var(--radius-sm)]">
            <NeyraLogo size={36} />
          </Link>
          <h1 className="text-[22px] font-semibold tracking-tight text-[var(--text)]">
            {mode === 'login' ? 'Neyra' : 'Создать профиль'}
          </h1>
          <p className="text-[13px] text-[var(--text-muted)] leading-relaxed">
            Ассистент для команды и личных задач
          </p>
        </div>

        {/* Invite banner if invite code applied from query */}
        {hasAppliedInvite && inviteCode && (
          <div className="flex items-center justify-between gap-2.5 rounded-[var(--radius-sm)] border border-[var(--border-control)] bg-[var(--surface-2)] p-2.5 text-xs text-[var(--text)]">
            <div className="flex items-center gap-2 min-w-0">
              <CheckCircle2 size={15} className="text-[var(--text-muted)] shrink-0" />
              <span className="truncate">Код из ссылки: <code className="font-mono text-[11px] text-[var(--text)]">{inviteCode.slice(0, 16)}</code></span>
            </div>
            <button
              type="button"
              onClick={() => setInviteCode('')}
              className="text-[11px] text-[var(--text-subtle)] hover:text-[var(--text)] underline cursor-pointer shrink-0"
            >
              Сменить
            </button>
          </div>
        )}

        {/* Invite code input if required and not applied */}
        {inviteRequired && !hasAppliedInvite && (
          <div className="space-y-1.5">
            <TextField
              label="Код приглашения"
              name="inviteCode"
              placeholder="NEYRA-XXXX-XXXX"
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value)}
              error={fieldErrors.inviteCode}
              hint="Регистрация и вход доступны только по коду приглашения"
            />
          </div>
        )}

        {/* Error banner */}
        {error && (
          <div
            role="alert"
            className="flex items-start gap-2.5 rounded-[var(--radius-sm)] border border-[var(--danger)] bg-[var(--danger-quiet)] p-3 text-xs text-[var(--danger)] leading-relaxed animate-in fade-in duration-150"
          >
            <AlertCircle size={15} className="shrink-0 mt-0.5 text-[var(--danger)]" />
            <div className="flex-1">{error}</div>
          </div>
        )}

        {/* Primary Discord login button */}
        {showDiscord && (
          <div className="space-y-2.5">
            <Button
              type="button"
              variant="secondary"
              size="lg"
              disabled={discordPending}
              loading={discordPending}
              onClick={handleDiscordSignIn}
              className="w-full h-11 min-h-[44px] flex items-center justify-center gap-2.5 bg-[#5865F2] hover:bg-[#4752c4] text-white border-transparent cursor-pointer font-medium text-sm shadow-sm transition-colors"
            >
              <DiscordIcon size={20} />
              <span>Продолжить с Discord</span>
            </Button>
            <p className="text-[11px] text-[var(--text-subtle)] text-center leading-normal px-2">
              Discord подключает память и историю из Discord к вашему профилю
            </p>
          </div>
        )}

        {/* Divider / Email disclosure */}
        {showDiscord && (
          <div className="relative my-3 select-none">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-[var(--border)]" />
            </div>
            <div className="relative flex justify-center text-xs">
              <span className="bg-[var(--surface)] px-2.5 text-[var(--text-subtle)]">или</span>
            </div>
          </div>
        )}

        {/* Email toggle button if Discord is enabled */}
        {showDiscord && !showEmailForm && (
          <button
            type="button"
            onClick={() => setShowEmailForm(true)}
            className="w-full py-2 text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text)] transition-colors text-center cursor-pointer flex items-center justify-center gap-1.5"
          >
            <span>Войти по email</span>
            <ChevronDown size={14} />
          </button>
        )}

        {/* Password / Email Form */}
        <div className={showDiscord && !showEmailForm ? 'hidden' : 'space-y-4'}>
          <form onSubmit={submit} className="space-y-3.5" aria-busy={pending} noValidate>
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

            <div className="space-y-1">
              <PasswordField
                label={ru.password}
                name="password"
                autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                minLength={10}
                maxLength={128}
                required
                disabled={pending}
                placeholder="••••••••••"
                error={fieldErrors.password}
                hint={mode === 'signup' ? 'Не менее 10 символов' : undefined}
              />
              {mode === 'login' && (
                <div className="text-right">
                  <Link
                    href="/reset-password"
                    className="text-[11px] text-[var(--text-subtle)] hover:text-[var(--text)] transition-colors focus-visible:outline-none focus-visible:underline"
                  >
                    Забыли пароль?
                  </Link>
                </div>
              )}
            </div>

            <Button
              type="submit"
              variant="primary"
              size="lg"
              disabled={pending}
              loading={pending}
              className="w-full h-10 text-xs font-medium"
            >
              {mode === 'login' ? ru.submit : ru.register}
            </Button>
          </form>
        </div>

        {/* Footnote on registration */}
        <p className="text-[11px] text-[var(--text-subtle)] text-center leading-normal">
          Регистрация происходит автоматически при первом входе
        </p>

        {/* Troubleshooting Accordion */}
        <div className="border-t border-[var(--border)] pt-3 text-center">
          <button
            type="button"
            onClick={() => setShowHelp((prev) => !prev)}
            className="text-xs text-[var(--text-subtle)] hover:text-[var(--text)] transition-colors inline-flex items-center gap-1 cursor-pointer"
          >
            <HelpCircle size={13} />
            <span>Проблемы со входом?</span>
          </button>

          {showHelp && (
            <div className="mt-3 p-3 rounded-[var(--radius-sm)] bg-[var(--surface-2)] border border-[var(--border)] text-left text-xs space-y-2 text-[var(--text-muted)] animate-in fade-in duration-150">
              <p>
                <strong>Discord не открылся?</strong> Отключите блокировщики всплывающих окон или откройте страницу в обычном браузере.
              </p>
              <p>
                <strong>Нет доступа?</strong> Если регистрация закрыта или работает по инвайтам, запросите код у администратора сервера.
              </p>
              <p>
                <strong>Забыли пароль от веб-аккаунта?</strong> Обратитесь к администратору для генерации временной ссылки сброса.
              </p>
            </div>
          )}
        </div>

        {/* Secondary footer links */}
        <div className="flex items-center justify-center gap-4 text-[11px] text-[var(--text-subtle)] pt-1">
          <button
            type="button"
            onClick={() => emitToast({ title: 'Политика и данные', message: 'Neyra хранит данные локально и шифрует сессии.' })}
            className="hover:text-[var(--text)] transition-colors cursor-pointer inline-flex items-center gap-1"
          >
            <ShieldCheck size={12} />
            <span>Политика и данные</span>
          </button>
          <span>•</span>
          <Link
            href="/api/health"
            target="_blank"
            className="hover:text-[var(--text)] transition-colors inline-flex items-center gap-1"
          >
            <Activity size={12} />
            <span>Статус сервиса</span>
          </Link>
        </div>
      </main>
    </div>
  );
}
