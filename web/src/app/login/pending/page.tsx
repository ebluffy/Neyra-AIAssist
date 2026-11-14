'use client';

import React from 'react';
import Link from 'next/link';
import { RefreshCw, ExternalLink, ArrowLeft } from 'lucide-react';
import { Button, NeyraLogo } from '../../../components/ui';

export default function LoginPendingPage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 sm:p-6 bg-[var(--surface)] text-[var(--text)]">
      <main className="w-full max-w-[380px] p-6 rounded-[var(--radius)] bg-[var(--surface-2)] border border-[var(--border-control)] space-y-6 text-center shadow-lg animate-in fade-in duration-150">
        <div className="flex flex-col items-center gap-3">
          <NeyraLogo size={36} />
          <h1 className="text-xl font-semibold tracking-tight text-[var(--text)]">
            Ожидание входа через Discord
          </h1>
          <p className="text-xs text-[var(--text-muted)] leading-relaxed">
            Открыли Discord в новой вкладке. Пожалуйста, подтвердите доступ к вашему профилю.
          </p>
        </div>

        {/* Pulse / skeleton placeholder */}
        <div className="p-4 rounded-[var(--radius-sm)] bg-[var(--surface-3)] border border-[var(--border)] space-y-2.5">
          <div className="flex items-center justify-center gap-2 text-xs text-[var(--text)]">
            <RefreshCw size={15} className="animate-spin text-[var(--accent)]" />
            <span>Ожидаем подтверждения от Discord…</span>
          </div>
          <div className="h-1.5 w-full bg-[var(--surface)] rounded-full overflow-hidden">
            <div className="h-full bg-[var(--accent)] animate-pulse w-2/3 rounded-full" />
          </div>
        </div>

        <div className="space-y-2.5">
          <Button
            type="button"
            variant="primary"
            size="lg"
            className="w-full h-11 min-h-[44px] gap-2"
            onClick={() => {
              window.open('https://discord.com/oauth2/authorize', '_blank');
            }}
          >
            <ExternalLink size={16} />
            <span>Открыть Discord снова</span>
          </Button>

          <Link href="/login" className="block">
            <Button
              type="button"
              variant="secondary"
              size="md"
              className="w-full h-9 gap-1.5 text-xs text-[var(--text-muted)]"
            >
              <ArrowLeft size={14} />
              <span>Вернуться ко входу</span>
            </Button>
          </Link>
        </div>
      </main>
    </div>
  );
}
