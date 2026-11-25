import Link from 'next/link';
import { pageCount } from '../../../lib/admin-rules';

export function Pagination({ page, pageSize, total, basePath, params = {} }: {
  page: number;
  pageSize: number;
  total: number;
  basePath: string;
  params?: Record<string, string | number | undefined>;
}) {
  const pages = pageCount(total, pageSize);
  if (pages <= 1) return null;
  const href = (nextPage: number) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '' && value !== 'all') query.set(key, String(value));
    }
    query.set('page', String(nextPage));
    return `${basePath}?${query.toString()}`;
  };
  const linkClass = 'rounded-[var(--radius)] border border-[var(--border)] px-3 py-1.5 text-xs hover:bg-white/5';
  return (
    <nav aria-label="Страницы" className="mt-4 flex items-center justify-between gap-3 text-xs text-[var(--muted)]">
      <span>Страница {page} из {pages} · всего {total}</span>
      <div className="flex gap-2">
        {page > 1
          ? <Link className={linkClass} href={href(page - 1)} rel="prev">Назад</Link>
          : <span className={`${linkClass} opacity-40`} aria-disabled="true">Назад</span>}
        {page < pages
          ? <Link className={linkClass} href={href(page + 1)} rel="next">Вперёд</Link>
          : <span className={`${linkClass} opacity-40`} aria-disabled="true">Вперёд</span>}
      </div>
    </nav>
  );
}
