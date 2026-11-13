'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, Field } from '@neyra/ui';
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
      <main className="mx-auto max-w-sm space-y-4 p-8">
        <h1>Сброс пароля</h1>
        <p role="alert">В ссылке нет кода сброса. Попросите администратора Нейры создать новую ссылку.</p>
        <Link href="/login">Ко входу</Link>
      </main>
    );
  }

  if (done) {
    return (
      <main className="mx-auto max-w-sm space-y-4 p-8">
        <h1>Пароль изменён</h1>
        <p>Теперь можно войти с новым паролем.</p>
        <Link href="/login">Ко входу</Link>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-sm space-y-6 p-8">
      <h1>Новый пароль</h1>
      <form onSubmit={submit} className="space-y-4" aria-busy={pending}>
        <Field label="Новый пароль" name="password" type="password" autoComplete="new-password" minLength={MIN_PASSWORD} maxLength={MAX_PASSWORD} required disabled={pending} />
        <Field label="Повторите пароль" name="repeat" type="password" autoComplete="new-password" minLength={MIN_PASSWORD} maxLength={MAX_PASSWORD} required disabled={pending} />
        {error && <p role="alert">{error}</p>}
        <Button type="submit" disabled={pending}>{pending ? ru.wait : 'Сохранить пароль'}</Button>
      </form>
      <Link href="/login">Ко входу</Link>
    </main>
  );
}
