'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Lock, ArrowRight, UserX } from 'lucide-react';
import { Button, TextField, NeyraLogo } from '../../../components/ui';

export default function LoginDeniedPage() {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [error, setError] = useState('');

  const handleContinue = (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim()) {
      setError('Введите код приглашения');
      return;
    }
    router.push(`/login?invite=${encodeURIComponent(code.trim())}`);
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 sm:p-6 bg-[var(--surface)] text-[var(--text)]">
      <main className="w-full max-w-[380px] p-6 rounded-[var(--radius)] bg-[var(--surface-2)] border border-[var(--border-control)] space-y-6 text-center shadow-lg animate-in fade-in duration-150">
        <div className="flex flex-col items-center gap-3">
          <div className="w-12 h-12 rounded-full bg-[var(--surface-3)] border border-[var(--border)] flex items-center justify-center text-[var(--text-subtle)]">
            <Lock size={22} />
          </div>
          <h1 className="text-xl font-semibold tracking-tight text-[var(--text)]">
            Доступ по приглашению
          </h1>
          <p className="text-xs text-[var(--text-muted)] leading-relaxed">
            Этот экземпляр Neyra закрыт для свободной регистрации. Для входа требуется код от администратора.
          </p>
        </div>

        <form onSubmit={handleContinue} className="space-y-4 text-left">
          <TextField
            label="Код приглашения"
            name="inviteCode"
            placeholder="NEYRA-XXXX-XXXX"
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
              if (error) setError('');
            }}
            error={error}
            hint="Одноразовый или постоянный ключ доступа"
          />

          <Button
            type="submit"
            variant="primary"
            size="lg"
            className="w-full h-11 min-h-[44px] gap-2 text-xs font-medium"
          >
            <span>Продолжить</span>
            <ArrowRight size={15} />
          </Button>
        </form>

        <div className="border-t border-[var(--border)] pt-4">
          <Link href="/login" className="block">
            <Button
              type="button"
              variant="secondary"
              size="md"
              className="w-full h-9 gap-1.5 text-xs text-[var(--text-muted)]"
            >
              <UserX size={14} />
              <span>Войти другим аккаунтом</span>
            </Button>
          </Link>
        </div>
      </main>
    </div>
  );
}
