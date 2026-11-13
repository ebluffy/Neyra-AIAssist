import Link from 'next/link';
import { ArrowLeft, KeyRound, Palette } from 'lucide-react';
import { NeyraLogo } from '../../components/ui';

export const dynamic = 'force-dynamic';

export default function SettingsPage() {
  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <header className="h-14 border-b border-[var(--border)] px-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link
            href="/chat"
            className="inline-flex items-center gap-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text)] transition-colors"
          >
            <ArrowLeft size={14} />
            <span>К чату</span>
          </Link>
          <span className="text-xs text-[var(--text-subtle)]">/</span>
          <h1 className="text-sm font-semibold tracking-tight">Настройки</h1>
        </div>
        <Link href="/" className="flex items-center gap-2">
          <NeyraLogo size={22} />
          <span className="text-sm font-semibold">Neyra</span>
        </Link>
      </header>

      <main className="content-column py-8 space-y-6 max-w-2xl">
        <section className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5 space-y-4">
          <div className="flex items-center gap-2.5 pb-3 border-b border-[var(--border)]">
            <Palette size={18} className="text-[var(--text-muted)]" />
            <h2 className="text-sm font-semibold">Внешний вид</h2>
          </div>
          <div className="text-xs text-[var(--text-muted)] flex justify-between items-center">
            <span>Тема оформления</span>
            <span className="font-mono text-[var(--text)] bg-[var(--surface-2)] px-2.5 py-1 rounded-[var(--radius-sm)] border border-[var(--border)]">
              Тёмная (монохром)
            </span>
          </div>
        </section>

        <section className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5 space-y-4">
          <div className="flex items-center gap-2.5 pb-3 border-b border-[var(--border)]">
            <KeyRound size={18} className="text-[var(--text-muted)]" />
            <h2 className="text-sm font-semibold">Безопасность</h2>
          </div>
          <p className="text-xs text-[var(--text-muted)] leading-relaxed">
            Смена пароля и управление доступом осуществляются администратором через разовые защищённые ссылки сброса.
          </p>
        </section>
      </main>
    </div>
  );
}
