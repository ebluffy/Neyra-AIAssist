'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { SignOut } from '../sign-out';

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

export function AdminNav({ name, email }: { name: string; email: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Разделы админки" className="border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--background)_94%,white)]">
      <div className="mx-auto max-w-[1200px] px-4 py-2 lg:px-8">
        <div className="flex items-center justify-between gap-3">
          <Link href="/admin" className="shrink-0 text-sm font-semibold tracking-tight">Нейра · Админка</Link>
          <div className="flex min-w-0 items-center gap-2 text-xs text-[var(--muted)]">
            <span className="min-w-0 truncate text-[var(--foreground)] sm:hidden">{name}</span>
            <span className="hidden shrink-0 text-right sm:block">
              <span className="block text-[var(--foreground)]">{name}</span>
              <span className="block">{email}</span>
            </span>
            <Link href="/" className="hidden shrink-0 rounded-full border border-[var(--border)] px-3 py-1.5 hover:text-[var(--foreground)] sm:inline-block">
              На сайт
            </Link>
            <SignOut />
          </div>
        </div>
        <ul className="-mx-1 mt-2 flex items-center gap-1 overflow-x-auto px-1 pb-1">
          {items.map(item => {
            const active = isActive(pathname, item.href);
            return (
              <li key={item.href} className="shrink-0">
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
      </div>
    </nav>
  );
}
