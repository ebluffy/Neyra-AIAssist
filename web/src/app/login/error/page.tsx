'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertCircle, RotateCcw, Mail, ArrowLeft } from 'lucide-react';
import { Button, NeyraLogo } from '../../../components/ui';

export default function LoginErrorPage() {
  const [errorCode, setErrorCode] = useState('OAUTH_CALLBACK_FAILED');
  const [errorMessage, setErrorMessage] = useState(
    'Не удалось завершить авторизацию через Discord. Сервер не получил подтверждения.'
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code') || params.get('error') || 'OAUTH_CALLBACK_FAILED';
    setErrorCode(code);

    if (code === 'access_denied') {
      setErrorMessage('Вы отменили подтверждение доступа в Discord.');
    } else if (code === 'guild_mismatch') {
      setErrorMessage('Ваш Discord-аккаунт не состоит на требуемом сервере сообщества.');
    } else if (code === 'rate_limit') {
      setErrorMessage('Слишком много запросов на авторизацию. Подождите 5 минут.');
    }
  }, []);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 sm:p-6 bg-[var(--surface)] text-[var(--text)]">
      <main className="w-full max-w-[380px] p-6 rounded-[var(--radius)] bg-[var(--surface-2)] border border-[var(--border-control)] space-y-6 text-center shadow-lg animate-in fade-in duration-150">
        <div className="flex flex-col items-center gap-3">
          <div className="w-12 h-12 rounded-full bg-[var(--danger-quiet)] border border-[var(--danger)] flex items-center justify-center text-[var(--danger)]">
            <AlertCircle size={24} />
          </div>
          <h1 className="text-xl font-semibold tracking-tight text-[var(--text)]">
            Ошибка авторизации
          </h1>
          <p className="text-xs text-[var(--text-muted)] leading-relaxed">
            {errorMessage}
          </p>
          <div className="inline-flex items-center px-2 py-0.5 rounded bg-[var(--surface-3)] border border-[var(--border)] text-[10px] font-mono text-[var(--text-subtle)]">
            Код: {errorCode}
          </div>
        </div>

        <div className="space-y-2.5">
          <Link href="/login" className="block">
            <Button
              type="button"
              variant="primary"
              size="lg"
              className="w-full h-11 min-h-[44px] gap-2 text-xs font-medium"
            >
              <RotateCcw size={15} />
              <span>Повторить попытку</span>
            </Button>
          </Link>

          <Button
            type="button"
            variant="secondary"
            size="md"
            className="w-full h-9 gap-1.5 text-xs text-[var(--text-muted)]"
            onClick={() => {
              window.location.href = 'mailto:admin@neyra.local?subject=Neyra%20Auth%20Issue';
            }}
          >
            <Mail size={14} />
            <span>Написать администратору</span>
          </Button>
        </div>
      </main>
    </div>
  );
}
