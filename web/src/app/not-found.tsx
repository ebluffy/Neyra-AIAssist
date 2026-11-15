import Link from 'next/link';

// Общая 404: не раскрывает, существует ли закрытая страница (например, /admin).
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-3 p-8 text-center">
      <p className="font-mono text-xs text-[var(--muted)]">404</p>
      <h1 className="text-xl font-semibold">Страница не найдена</h1>
      <p className="text-sm text-[var(--muted)]">Возможно, ссылка устарела или у вас нет доступа к этой странице.</p>
      <Link href="/" className="mt-2 rounded-[var(--radius)] border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-white/5">
        На главную
      </Link>
    </main>
  );
}
