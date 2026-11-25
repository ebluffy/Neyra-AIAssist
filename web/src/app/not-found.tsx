import Link from 'next/link';
import { NeyraLogo } from '../components/ui';

// Общая 404: строгий монохромный дизайн
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 p-8 text-center bg-[var(--bg)] text-[var(--text)] select-none">
      <NeyraLogo size={36} />
      <span className="font-mono text-xs px-2 py-0.5 rounded-[var(--radius-full)] border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-muted)]">
        404
      </span>
      <h1 className="text-xl font-semibold tracking-tight text-[var(--text)]">Страница не найдена</h1>
      <p className="text-sm text-[var(--text-muted)] leading-relaxed">
        Возможно, ссылка устарела или у вас нет доступа к этой странице.
      </p>
      <Link
        href="/"
        className="mt-2 inline-flex items-center justify-center rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-2)] px-4 py-2 text-sm font-medium text-[var(--text)] hover:bg-[var(--surface-3)] hover:border-[var(--border-strong)] transition-transform active:scale-[0.98]"
      >
        На главную
      </Link>
    </main>
  );
}
