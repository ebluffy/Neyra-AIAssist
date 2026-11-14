import type { ReactNode } from 'react';

// Общие блоки админки: строгий монохромный дизайн без цветных пятен

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-[var(--text)]">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-[var(--text-muted)]">{description}</p>}
      </div>
      {actions}
    </header>
  );
}

export function Card({ title, description, children, footer }: {
  title?: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <section className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] text-[var(--text)]">
      {(title || description) && (
        <div className="border-b border-[var(--border)] px-4 py-3">
          {title && <h2 className="text-sm font-semibold text-[var(--text)]">{title}</h2>}
          {description && <p className="mt-1 text-xs text-[var(--text-muted)]">{description}</p>}
        </div>
      )}
      <div className="px-4 py-3">{children}</div>
      {footer && <div className="border-t border-[var(--border)] px-4 py-3 text-xs text-[var(--text-muted)]">{footer}</div>}
    </section>
  );
}

export function EmptyState({ title, text }: { title: string; text: string }) {
  return (
    <div className="rounded-[var(--radius)] border border-dashed border-[var(--border)] px-4 py-8 text-center bg-[var(--surface-2)]">
      <p className="text-sm font-medium text-[var(--text)]">{title}</p>
      <p className="mx-auto mt-1 max-w-lg text-xs text-[var(--text-muted)]">{text}</p>
    </div>
  );
}

export type Tone = 'ok' | 'warn' | 'error' | 'muted';

// Строгая монохромная палитра статусов по яркости
const toneClass: Record<Tone, string> = {
  ok: 'border-[var(--border-strong)] bg-[var(--surface-3)] text-[var(--text)]',
  warn: 'border-[var(--border-strong)] bg-[var(--surface-2)] text-[var(--text-muted)]',
  error: 'border-[var(--danger)] bg-[var(--danger-quiet)] text-[var(--danger)]',
  muted: 'border-[var(--border)] bg-transparent text-[var(--text-subtle)]',
};

export function StatusPill({ tone = 'muted', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${toneClass[tone]}`}>
      {children}
    </span>
  );
}

export function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
      <p className="text-xs text-[var(--text-muted)]">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-[var(--text)]">{value}</p>
      {hint && <p className="mt-1 text-xs text-[var(--text-subtle)]">{hint}</p>}
    </div>
  );
}

const dateFormat = new Intl.DateTimeFormat('ru-RU', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'Europe/Moscow',
});

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return `${dateFormat.format(date)} МСК`;
}

export function formatBytes(value: number | null | undefined): string {
  if (!value || value <= 0) return '—';
  const units = ['Б', 'КиБ', 'МиБ', 'ГиБ', 'ТиБ'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return '—';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} д ${hours} ч`;
  if (hours > 0) return `${hours} ч ${minutes} мин`;
  return `${minutes} мин`;
}

// Классы таблиц в одном месте, адаптивная карточная раскладка на мобильных
export const tableClass = 'w-full min-w-full lg:min-w-[720px] border-collapse text-sm';
export const thClass = 'border-b border-[var(--border)] px-3 py-2.5 text-left text-xs font-medium uppercase tracking-wider text-[var(--text-subtle)]';
export const tdClass = 'border-b border-[var(--border)] px-3 py-2.5 align-middle text-[var(--text)]';
