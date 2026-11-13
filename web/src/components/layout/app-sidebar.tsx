'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Hash,
  LogOut,
  MessageSquare,
  PanelLeft,
  Plus,
  Search,
  Settings,
  Shield,
  X,
} from 'lucide-react';
import { Avatar, Button, IconButton, NeyraLogo } from '../ui';
import { resetChatId, resolveTabKey } from '../../../lib/chat-id';
import { signOut } from '../../../lib/auth-client';

export interface AppSidebarUser {
  id: string;
  name?: string | null;
  email?: string | null;
  role?: string | null;
}

export interface AppSidebarProps {
  activeSection: 'chat' | 'channels' | 'settings' | 'admin';
  user?: AppSidebarUser | null;
  threadTitle?: string | null;
  onNewChat?: () => void;
  mobileOpen?: boolean;
  onCloseMobile?: () => void;
}

export function AppSidebar({
  activeSection,
  user,
  threadTitle,
  onNewChat,
  mobileOpen = false,
  onCloseMobile,
}: AppSidebarProps) {
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const profileMenuRef = useRef<HTMLDivElement | null>(null);
  const profileTriggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem('neyra:sidebar-collapsed') === '1');
    } catch {}
  }, []);

  function toggleCollapse() {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem('neyra:sidebar-collapsed', next ? '1' : '0');
      } catch {}
      return next;
    });
  }

  // Close profile menu on outside click or Esc
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        profileMenuRef.current &&
        !profileMenuRef.current.contains(event.target as Node) &&
        profileTriggerRef.current &&
        !profileTriggerRef.current.contains(event.target as Node)
      ) {
        setProfileMenuOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && profileMenuOpen) {
        setProfileMenuOpen(false);
        profileTriggerRef.current?.focus();
      }
    }
    if (profileMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [profileMenuOpen]);

  function handleStartNewChat() {
    if (onNewChat) {
      onNewChat();
    } else {
      if (user?.id) {
        try {
          resetChatId(window.sessionStorage, resolveTabKey(window), user.id);
        } catch {}
      }
      router.push('/chat');
    }
    onCloseMobile?.();
  }

  const isAdmin = user?.role === 'admin';
  const displayName = user?.name && user.name !== user.email ? user.name : user?.email || 'Пользователь';

  return (
    <>
      {/* Mobile Backdrop */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 lg:hidden backdrop-blur-sm transition-opacity"
          onClick={onCloseMobile}
          aria-hidden="true"
        />
      )}

      {/* Main Sidebar Shell */}
      <aside
        className={`relative z-50 fixed lg:static inset-y-0 left-0 bg-[var(--surface)] border-r border-[var(--border)] flex flex-col justify-between transition-[transform,width] duration-150 ease-out select-none ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        } ${collapsed ? 'w-[264px] lg:w-[64px]' : 'w-[264px]'}`}
        aria-label="Боковая панель навигации"
      >
        {/* COLLAPSED RAIL (Desktop only, when collapsed) */}
        {collapsed && (
          <div className="hidden lg:flex flex-col items-center justify-between h-full py-3 px-2">
            <div className="flex flex-col items-center gap-2">
              <IconButton
                aria-label="Развернуть панель"
                tooltip="Развернуть панель"
                icon={<PanelLeft size={16} />}
                variant="ghost"
                size="md"
                onClick={toggleCollapse}
              />
              <IconButton
                aria-label="Новый чат"
                tooltip="Новый чат"
                icon={<Plus size={16} />}
                variant="secondary"
                size="md"
                onClick={handleStartNewChat}
              />
              <IconButton
                aria-label="Чаты"
                tooltip="Чаты"
                icon={<MessageSquare size={16} />}
                variant={activeSection === 'chat' ? 'secondary' : 'ghost'}
                size="md"
                onClick={() => router.push('/chat')}
              />
              {isAdmin && (
                <IconButton
                  aria-label="Каналы"
                  tooltip="Каналы"
                  icon={<Hash size={16} />}
                  variant={activeSection === 'channels' ? 'secondary' : 'ghost'}
                  size="md"
                  onClick={() => router.push('/channels')}
                />
              )}
            </div>

            <div className="flex flex-col items-center gap-2">
              <IconButton
                aria-label="Настройки"
                tooltip="Настройки"
                icon={<Settings size={16} />}
                variant={activeSection === 'settings' ? 'secondary' : 'ghost'}
                size="md"
                onClick={() => router.push('/settings')}
              />
              <button
                ref={profileTriggerRef}
                type="button"
                aria-haspopup="menu"
                aria-expanded={profileMenuOpen}
                aria-label="Профиль"
                onClick={() => setProfileMenuOpen((prev) => !prev)}
                className="rounded-full p-0.5 hover:ring-2 hover:ring-[var(--border-strong)] transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              >
                <Avatar name={user?.name} email={user?.email} size={28} />
              </button>
            </div>
          </div>
        )}

        {/* EXPANDED SIDEBAR (or Mobile drawer) */}
        <div className={`flex flex-col justify-between h-full ${collapsed ? 'lg:hidden' : ''}`}>
          {/* Top Section: Header & Actions */}
          <div className="p-3.5 space-y-4">
            {/* Logo row */}
            <div className="flex items-center justify-between">
              <Link
                href="/"
                className="flex items-center gap-2.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)] rounded-[var(--radius-sm)] px-1 py-0.5"
              >
                <NeyraLogo size={22} />
                <span className="text-[15px] font-semibold tracking-tight text-[var(--text)]">Neyra</span>
              </Link>
              <div className="flex items-center gap-1">
                <IconButton
                  aria-label="Свернуть панель"
                  tooltip="Свернуть панель"
                  icon={<PanelLeft size={15} />}
                  variant="ghost"
                  size="sm"
                  className="hidden lg:inline-flex"
                  onClick={toggleCollapse}
                />
                <IconButton
                  aria-label="Закрыть панель"
                  icon={<X size={16} />}
                  variant="ghost"
                  size="sm"
                  className="lg:hidden"
                  onClick={onCloseMobile}
                />
              </div>
            </div>

            {/* New Chat Button */}
            <Button
              variant="secondary"
              className="w-full justify-start gap-2 h-9 text-xs font-medium"
              onClick={handleStartNewChat}
            >
              <Plus size={15} className="shrink-0" />
              <span>Новый чат</span>
            </Button>

            {/* Nav list */}
            <nav className="space-y-1" aria-label="Основные разделы">
              <Link
                href="/chat"
                className={`flex items-center gap-2.5 px-2.5 py-1.5 rounded-[var(--radius-sm)] text-xs font-medium transition-colors ${
                  activeSection === 'chat'
                    ? 'bg-[var(--surface-3)] text-[var(--text)] font-semibold'
                    : 'text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-2)]'
                }`}
              >
                <MessageSquare size={15} className="shrink-0" />
                <span>Чаты</span>
              </Link>

              {isAdmin && (
                <Link
                  href="/channels"
                  className={`flex items-center gap-2.5 px-2.5 py-1.5 rounded-[var(--radius-sm)] text-xs font-medium transition-colors ${
                    activeSection === 'channels'
                      ? 'bg-[var(--surface-3)] text-[var(--text)] font-semibold'
                      : 'text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-2)]'
                  }`}
                >
                  <Hash size={15} className="shrink-0" />
                  <span>Каналы (Discord)</span>
                </Link>
              )}
            </nav>

            {/* Thread Info (if present in chat) */}
            {threadTitle && (
              <div className="pt-2 border-t border-[var(--border)]">
                <div className="px-1 mb-1.5 text-[11px] font-medium text-[var(--text-subtle)]">
                  Текущий диалог
                </div>
                <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-[var(--radius-sm)] bg-[var(--surface-2)] text-[var(--text)] border-l-2 border-[var(--accent)] text-xs font-medium truncate cursor-default">
                  <MessageSquare size={13} className="shrink-0 text-[var(--text-muted)]" />
                  <span className="truncate">{threadTitle}</span>
                </div>
              </div>
            )}
          </div>

          {/* Bottom Section: Profile & Popover */}
          <div className="relative border-t border-[var(--border)] p-3 bg-[var(--surface)]">
            <button
              ref={profileTriggerRef}
              type="button"
              aria-haspopup="menu"
              aria-expanded={profileMenuOpen}
              aria-label="Меню профиля пользователя"
              onClick={() => setProfileMenuOpen((prev) => !prev)}
              className="w-full flex items-center justify-between gap-2 p-1.5 rounded-[var(--radius-sm)] hover:bg-[var(--surface-2)] transition-colors text-left cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <Avatar name={user?.name} email={user?.email} size={28} />
                <div className="min-w-0 flex flex-col">
                  <span className="text-xs font-medium text-[var(--text)] truncate">{displayName}</span>
                  <span className="text-[10px] text-[var(--text-subtle)] truncate">
                    {isAdmin ? 'Администратор' : 'Пользователь'}
                  </span>
                </div>
              </div>
            </button>

            {/* Profile Popover Menu */}
            {profileMenuOpen && (
              <div
                ref={profileMenuRef}
                role="menu"
                aria-label="Меню профиля"
                className="absolute bottom-full left-3 right-3 mb-2 bg-[var(--surface-2)] border border-[var(--border)] rounded-[var(--radius)] shadow-lg p-1.5 z-50 space-y-0.5 text-xs animate-in fade-in zoom-in-95 duration-150"
              >
                <div className="px-2.5 py-1.5 border-b border-[var(--border)] mb-1">
                  <div className="font-medium text-[var(--text)] truncate">{displayName}</div>
                  {user?.email && <div className="text-[10px] text-[var(--text-subtle)] truncate">{user.email}</div>}
                </div>

                <Link
                  href="/settings"
                  role="menuitem"
                  onClick={() => setProfileMenuOpen(false)}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-[var(--radius-sm)] text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-3)] transition-colors text-left"
                >
                  <Settings size={14} className="shrink-0" />
                  <span>Настройки</span>
                </Link>

                {isAdmin && (
                  <Link
                    href="/admin/system"
                    role="menuitem"
                    onClick={() => setProfileMenuOpen(false)}
                    className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-[var(--radius-sm)] text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-3)] transition-colors text-left"
                  >
                    <Shield size={14} className="shrink-0" />
                    <span>Панель управления</span>
                  </Link>
                )}

                <button
                  type="button"
                  role="menuitem"
                  onClick={async () => {
                    setProfileMenuOpen(false);
                    await signOut();
                    router.push('/login');
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-[var(--radius-sm)] text-[var(--danger)] hover:bg-[var(--danger-quiet)] transition-colors text-left cursor-pointer"
                >
                  <LogOut size={14} className="shrink-0" />
                  <span>Выйти</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}
