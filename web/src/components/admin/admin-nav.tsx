'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ExternalLink, Menu, X } from 'lucide-react';
import { SignOut } from '../sign-out';
import { IconButton } from '../ui';

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
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Single identity string: user name if exists and different from email, else email
  const identity = name && name !== email ? name : email;

  return (
    <nav aria-label="Разделы админки" className="border-b border-[var(--border)] bg-[var(--surface)] text-[var(--text)]">
      <div className="mx-auto max-w-[1200px] px-4 py-2.5 lg:px-8">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <IconButton
              aria-label={mobileMenuOpen ? 'Закрыть меню' : 'Меню разделов'}
              tooltip={mobileMenuOpen ? 'Закрыть меню' : 'Меню разделов'}
              icon={mobileMenuOpen ? <X size={18} strokeWidth={1.5} /> : <Menu size={18} strokeWidth={1.5} />}
              variant="ghost"
              size="sm"
              className="lg:hidden"
              onClick={() => setMobileMenuOpen(prev => !prev)}
            />
            <Link href="/admin" className="shrink-0 text-sm font-semibold tracking-tight text-[var(--text)] flex items-center gap-2">
              <span>Нейра</span>
              <span className="text-xs font-normal text-[var(--text-subtle)]">/</span>
              <span className="text-xs font-medium text-[var(--text-muted)]">Админка</span>
            </Link>
          </div>

          <div className="flex min-w-0 items-center gap-3 text-xs text-[var(--text-muted)]">
            <span className="min-w-0 truncate text-[var(--text)] font-medium max-w-[180px] sm:max-w-[260px]" title={email}>
              {identity}
            </span>
            <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-subtle)] shrink-0">
              admin
            </span>
            <Link
              href="/"
              className="hidden sm:inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1 text-xs text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-3)] transition-colors shrink-0"
            >
              <span>На сайт</span>
              <ExternalLink size={12} strokeWidth={1.5} />
            </Link>
            <SignOut />
          </div>
        </div>

        {/* Desktop navigation pills */}
        <ul className="hidden lg:flex items-center gap-1 overflow-x-auto pt-2 pb-0.5">
          {items.map(item => {
            const active = isActive(pathname, item.href);
            return (
              <li key={item.href} className="shrink-0">
                <Link
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={`inline-flex rounded-[var(--radius-sm)] px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors ${
                    active
                      ? 'bg-[var(--accent)] text-[var(--accent-ink)] shadow-sm'
                      : 'text-[var(--text-muted)] hover:bg-[var(--surface-3)] hover:text-[var(--text)]'
                  }`}
                >
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>

        {/* Mobile drawer navigation */}
        {mobileMenuOpen && (
          <div className="lg:hidden pt-3 pb-2 border-t border-[var(--border)] mt-2.5 space-y-1">
            <div className="grid grid-cols-2 gap-1.5 pb-2">
              {items.map(item => {
                const active = isActive(pathname, item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setMobileMenuOpen(false)}
                    aria-current={active ? 'page' : undefined}
                    className={`flex items-center px-3 py-2 rounded-[var(--radius-sm)] text-xs font-medium transition-colors ${
                      active
                        ? 'bg-[var(--accent)] text-[var(--accent-ink)]'
                        : 'text-[var(--text-muted)] hover:bg-[var(--surface-3)] hover:text-[var(--text)] bg-[var(--surface-2)]'
                    }`}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </div>
            <div className="pt-2 border-t border-[var(--border)] flex justify-between items-center sm:hidden text-xs">
              <Link
                href="/"
                className="inline-flex items-center gap-1.5 text-[var(--text-muted)] hover:text-[var(--text)] py-1"
              >
                <span>Перейти на сайт</span>
                <ExternalLink size={12} strokeWidth={1.5} />
              </Link>
            </div>
          </div>
        )}
      </div>
    </nav>
  );
}
