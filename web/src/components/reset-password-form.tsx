'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, TextField, NeyraLogo } from './ui';
import { ru } from '../i18n';

const MIN_PASSWORD = 10;
const MAX_PASSWORD = 128;

// Сброс пароля по одноразовой ссылке из админки. Токен приходит в query и живёт час.
export function ResetPasswordForm({ token }: { token: string }) {
  const router = useRouter();
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    const password = String(form.get('password') ?? '');
    const repeat = String(form.get('repeat') ?? '');
    if (password.length < MIN_PASSWORD) {
      setError(`Пароль должен быть не короче ${MIN_PASSWORD} символов.`);
      return;
    }
    if (password !== repeat) {
      setError('Пароли не совпадают.');
      return;
    }
    setError('');
    setPending(true);
    try {
      const response = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ newPassword: password, token }),
      });
      const payload = await response.json().catch(() => null) as { message?: string } | null;
      if (!response.ok) {
        setError(payload?.message ?? 'Ссылка недействительна или истекла. Запросите новую у администратора.');
        return;
      }
      setDone(true);
      setTimeout(() => router.replace('/login'), 1500);
    } catch {
      setError(ru.networkError);
    } finally {
      setPending(false);
    }
  }

  if (!token) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-4 sm:p-6 bg-[var(--surface)] text-[var(--text)]">
        <main className="w-full max-w-[380px] space-y-6 text-center">
          <NeyraLogo size={36} className="mx-auto" />
          <h1 className="text-[22px] font-semibold tracking-tight text-[var(--text)]">Сброс пароля</h1>
          <div role="alert" className="rounded-[var(--radius)] border border-[var(--danger)] bg-[var(--danger-quiet)] p-3 text-xs text-[var(--danger)] leading-relaxed">
            В ссылке нет кода сброса. Попросите администратора Нейры создать новую ссылку.
          </div>
          <Link href="/login" className="text-[13px] text-[var(--accent)] font-medium hover:underline underline-offset-[3px]">
            Ко входу
          </Link>
        </main>
      </div>
    );
  }

  if (done) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-4 sm:p-6 bg-[var(--surface)] text-[var(--text)]">
        <main className="w-full max-w-[380px] space-y-6 text-center">
          <NeyraLogo size={36} className="mx-auto" />
          <h1 className="text-[22px] font-semibold tracking-tight text-[var(--text)]">Пароль изменён</h1>
          <p className="text-sm text-[var(--text-muted)]">Теперь можно войти с новым паролем.</p>
          <Link href="/login" className="text-[13px] text-[var(--accent)] font-medium hover:underline underline-offset-[3px]">
            Ко входу
          </Link>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 sm:p-6 bg-[var(--surface)] text-[var(--text)]">
      <main className="w-full max-w-[380px] space-y-6">
        <div className="flex flex-col items-center text-center gap-2 mb-2">
          <NeyraLogo size={36} />
          <h1 className="text-[22px] font-semibold tracking-tight text-[var(--text)]">Новый пароль</h1>
          <p className="text-[13px] text-[var(--text-muted)]">Задайте новый пароль для вашей учётной записи</p>
        </div>
        <form onSubmit={submit} className="space-y-4" aria-busy={pending} noValidate>
          <TextField
            label="Новый пароль"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={MIN_PASSWORD}
            maxLength={MAX_PASSWORD}
            required
            disabled={pending}
            placeholder="••••••••••"
            hint={`Не менее ${MIN_PASSWORD} символов`}
          />
          <TextField
            label="Повторите пароль"
            name="repeat"
            type="password"
            autoComplete="new-password"
            minLength={MIN_PASSWORD}
            maxLength={MAX_PASSWORD}
            required
            disabled={pending}
            placeholder="••••••••••"
          />
          {error && (
            <div role="alert" className="rounded-[var(--radius)] border border-[var(--danger)] bg-[var(--danger-quiet)] p-3 text-xs text-[var(--danger)] leading-relaxed">
              {error}
            </div>
          )}
          <Button type="submit" variant="primary" size="lg" loading={pending} className="w-full mt-2">
            {pending ? ru.wait : 'Сохранить пароль'}
          </Button>
        </form>
        <div className="text-center pt-2">
          <Link href="/login" className="text-[13px] text-[var(--text-muted)] hover:text-[var(--text)] transition-colors">
            Ко входу
          </Link>
        </div>
      </main>
    </div>
  );
}
