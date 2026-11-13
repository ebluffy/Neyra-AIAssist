'use client';

import React, { useState, useEffect, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CheckCircle2, Ticket } from 'lucide-react';
import { Button, TextField, NeyraLogo } from './ui';
import { signIn, signUp } from '../../lib/auth-client';
import { credentialsSchema, authErrorText } from '../../lib/auth-policy';
import type { AuthConfig } from '../../lib/env';
import type { RegistrationMode } from '../../lib/registration-mode';
import { ru } from '../i18n';

function DiscordIcon({ size = 18 }: { size?: number }) {
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
  // Режим из site_setting (сервер): invite | open | closed.
  registrationMode?: RegistrationMode;
}

export function AuthForm({ mode, config, initialError = '', invite = '', registrationMode }: AuthFormProps) {
  const router = useRouter();
  const [error, setError] = useState(initialError);
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string; inviteCode?: string }>({});
  const [pending, setPending] = useState(false);
  const [discordPending, setDiscordPending] = useState(false);
  const [inviteCode, setInviteCode] = useState(invite);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const mockErr = params.get('mockError');
    if (mockErr === '429') {
      setError('Слишком много попыток. Пожалуйста, подождите 15 минут.');
    } else if (mockErr === 'invalid') {
      setError('Неверный адрес почты или пароль.');
    } else if (mockErr === 'expired') {
      setError('Срок действия приглашения истёк.');
    } else if (mockErr === 'used') {
      setError('Недействительный или уже использованный код приглашения.');
    }
    const urlInvite = params.get('invite');
    if (urlInvite) {
      setInviteCode(urlInvite);
    }
  }, []);

  const authMode = config?.authMode ?? 'password';
  // Явный режим из БД важнее env; без него — прежнее поведение по INVITE_REQUIRED.
  const inviteRequired = registrationMode
    ? registrationMode === 'invite'
    : (config?.inviteRequired ?? false);
  const signupAllowed = registrationMode ? registrationMode !== 'closed' : true;
  const discordAvailable = config?.discordAvailable ?? false;

  const showDiscord = discordAvailable && (authMode === 'discord' || authMode === 'both');
  const isDiscordOnly = showDiscord && authMode === 'discord';

  // Contract #72: if invite link is provided, token is applied and input is hidden
  const hasAppliedInvite = !!invite || (typeof window !== 'undefined' && !!new URLSearchParams(window.location.search).get('invite'));

  async function handleDiscordSignIn() {
    if (discordPending) return;
    setDiscordPending(true);
    setError('');
    try {
      await signIn.social({
        provider: 'discord',
        callbackURL: '/',
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
        if (issue.path[0] === 'email' && !nextFieldErrors.email) nextFieldErrors.email = issue.message;
        if (issue.path[0] === 'password' && !nextFieldErrors.password) nextFieldErrors.password = issue.message;
      }
    }

    const token = inviteCode.trim();
    if (mode === 'signup' && inviteRequired && !hasAppliedInvite && !token) {
      nextFieldErrors.inviteCode = ru.inviteRequired;
    }

    if (Object.keys(nextFieldErrors).length > 0) {
      setFieldErrors(nextFieldErrors);
      const firstMsg =
        nextFieldErrors.email || nextFieldErrors.password || nextFieldErrors.inviteCode || 'Проверьте введённые данные.';
      setError(firstMsg);
      return;
    }

    if (!parsedCreds.success) return;

    setFieldErrors({});
    setError('');
    setPending(true);

    try {
      // Contract #72: pass token via `invite` property in request body
      const result =
        mode === 'signup'
          ? await signUp.email({
              ...parsedCreds.data,
              name: parsedCreds.data.email,
              invite: token,
            } as Parameters<typeof signUp.email>[0])
          : await signIn.email(parsedCreds.data);

      if (result.error) {
        // Display server-sent error message verbatim (e.g. 403 on expired or used invite)
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
      {/* Centered card 360-400px (spec §1.1) */}
      <main className="w-full max-w-[380px] space-y-6">
        {/* Compact logo header above card */}
        <div className="flex flex-col items-center text-center gap-2 mb-2">
          <NeyraLogo size={36} />
          <h1 className="text-[22px] font-semibold tracking-tight text-[var(--text)]">
            {mode === 'login' ? ru.login : ru.signup}
          </h1>
          <p className="text-[13px] text-[var(--text-muted)]">
            {mode === 'login'
              ? isDiscordOnly
                ? 'Вход в аккаунт через Discord'
                : 'Введите email и пароль для продолжения'
              : hasAppliedInvite
                ? 'Задайте учетные данные для регистрации'
                : 'Создайте новый аккаунт для доступа'}
          </p>
        </div>

        {/* Contract #72: Info note on signup — neutral monochrome styling */}
        {mode === 'signup' && inviteRequired && (
          hasAppliedInvite ? (
            <div className="flex items-start gap-2.5 rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--surface-2)] p-3 text-xs text-[var(--text)] leading-relaxed">
              <CheckCircle2 size={16} strokeWidth={1.5} className="text-[var(--text-muted)] shrink-0 mt-0.5" />
              <span>{ru.inviteApplied}</span>
            </div>
          ) : (
            <div className="flex items-start gap-2.5 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-2)] p-3 text-xs text-[var(--text-muted)] leading-relaxed">
              <Ticket size={16} strokeWidth={1.5} className="text-[var(--text-subtle)] shrink-0 mt-0.5" />
              <span>{ru.inviteOnly}</span>
            </div>
          )
        )}

        {error && (
          <div
            role="alert"
            className="rounded-[var(--radius)] border border-[var(--danger)] bg-[var(--danger-quiet)] p-3 text-xs text-[var(--danger)] leading-relaxed"
          >
            {error}
          </div>
        )}

        {/* Discord login button */}
        {showDiscord && (
          <div className="space-y-3">
            <Button
              type="button"
              variant="secondary"
              size="lg"
              disabled={discordPending}
              loading={discordPending}
              onClick={handleDiscordSignIn}
              className="w-full flex items-center justify-center gap-2.5 bg-[#5865F2] hover:bg-[#4752C4] text-white border-transparent cursor-pointer shadow-sm"
            >
              <DiscordIcon size={18} />
              <span>Войти через Discord</span>
            </Button>

            {authMode === 'both' && (
              <div className="relative my-4 select-none">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-[var(--border)]" />
                </div>
                <div className="relative flex justify-center text-xs">
                  <span className="bg-[var(--surface)] px-2.5 text-[var(--text-subtle)]">или</span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Password Form (hidden when Discord-only) */}
        {!isDiscordOnly && (
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

            {/* Contract #72: show invite field only when NOT applied from URL */}
            {mode === 'signup' && inviteRequired && !hasAppliedInvite && (
              <TextField
                label={ru.inviteCode}
                name="invite"
                type="text"
                autoComplete="off"
                required
                disabled={pending}
                placeholder="NEYRA-XXXX"
                value={inviteCode}
                onChange={e => setInviteCode(e.target.value)}
                error={fieldErrors.inviteCode}
              />
            )}

            <Button type="submit" variant="primary" size="lg" loading={pending} className="w-full mt-2">
              {pending ? ru.wait : mode === 'login' ? ru.submit : ru.register}
            </Button>
          </form>
        )}

        {/* Bottom link: Only show when registration is permitted by mode (spec §1.5) */}
        {!isDiscordOnly && (mode !== 'login' || signupAllowed) && (
          <div className="text-center pt-2">
            <span className="text-[13px] text-[var(--text-muted)]">
              {mode === 'login' ? 'Нет аккаунта? ' : 'Уже есть аккаунт? '}
            </span>
            <Link
              href={mode === 'login' ? '/signup' : '/login'}
              className="text-[13px] text-[var(--text)] font-medium hover:underline underline-offset-[3px] transition-all"
            >
              {mode === 'login' ? ru.signup : ru.login}
            </Link>
          </div>
        )}
      </main>
    </div>
  );
}
