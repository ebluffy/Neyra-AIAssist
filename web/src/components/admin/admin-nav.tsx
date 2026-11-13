'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const items = [
  { href: '/admin', label: 'Обзор' },
  { href: '/admin/users', label: 'Пользователи' },
  { href: '/admin/invites', label: 'Приглашения' },
  { href: '/admin/models', label: 'Модели' },
  { href: '/admin/prompts', label: 'Промпты и персона' },
  { href: '/admin/memory', label: 'Память' },
  { href: '/admin/files', label: 'Файлы' },
  { href: '/admin/integrations', label: 'Интеграции' },
  { href: '/admin/logs', label: 'Журналы' },
  { href: '/admin/system', label: 'Система' },
];

function isActive(pathname: string, href: string): boolean {
  if (href === '/admin') return pathname === '/admin';
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AdminNav({ email }: { email: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Разделы админки" className="border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--background)_94%,white)]">
      <div className="mx-auto flex max-w-[1200px] flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3 lg:px-8">
        <Link href="/admin" className="text-sm font-semibold tracking-tight">Нейра · Админка</Link>
        <ul className="flex flex-1 flex-wrap items-center gap-1 overflow-x-auto">
          {items.map(item => {
            const active = isActive(pathname, item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={`inline-flex rounded-full px-3 py-1.5 text-xs whitespace-nowrap transition-colors ${
                    active
                      ? 'bg-[var(--foreground)] text-[var(--background)]'
                      : 'text-[var(--muted)] hover:bg-white/5 hover:text-[var(--foreground)]'
                  }`}
                >
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
        <div className="flex items-center gap-3 text-xs text-[var(--muted)]">
          <span className="hidden sm:inline">{email}</span>
          <Link href="/" className="rounded-full border border-[var(--border)] px-3 py-1.5 hover:text-[var(--foreground)]">
            На сайт
          </Link>
        </div>
      </div>
    </nav>
  );
}
