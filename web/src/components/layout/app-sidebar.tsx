'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Check,
  Edit2,
  FileText,
  Hash,
  LogOut,
  MessageSquare,
  PanelLeft,
  Pin,
  Plus,
  Search,
  Settings,
  Shield,
  StickyNote,
  Trash2,
  X,
} from 'lucide-react';
import { Avatar, Button, IconButton, NeyraLogo } from '../ui';
import { resetChatId, resolveTabKey } from '../../../lib/chat-id';
import { signOut } from '../../../lib/auth-client';
import {
  apiListThreads,
  apiDeleteThread,
  apiListNotes,
  apiCreateNote,
  apiUpdateNote,
  apiDeleteNote,
  importLocalStorageData,
} from '../../../lib/history-client';
import { ru } from '../../i18n';
import { AdminDialog, type AdminSection } from '../admin/admin-dialog';

export interface AppSidebarUser {
  id: string;
  name?: string | null;
  email?: string | null;
  role?: string | null;
}

export interface ChatThreadItem {
  id: string;
  title: string;
  lastMessage?: string;
  updatedAt?: string;
}

export interface UserNote {
  id: string;
  title: string;
  content: string;
  updatedAt: string;
  pinned?: boolean;
}

function parseNoteText(text: string): { title: string; content: string } {
  const trimmed = (text || '').trim();
  const doubleBreak = trimmed.indexOf('\n\n');
  if (doubleBreak !== -1) {
    return {
      title: trimmed.slice(0, doubleBreak).trim() || 'Без названия',
      content: trimmed.slice(doubleBreak + 2).trim(),
    };
  }
  const singleBreak = trimmed.indexOf('\n');
  if (singleBreak !== -1) {
    return {
      title: trimmed.slice(0, singleBreak).trim() || 'Без названия',
      content: trimmed.slice(singleBreak + 1).trim(),
    };
  }
  if (trimmed.length <= 40) {
    return { title: trimmed || 'Без названия', content: '' };
  }
  return { title: trimmed.slice(0, 40) + '…', content: trimmed };
}

function formatNoteText(title: string, content: string): string {
  const t = title.trim();
  const c = content.trim();
  if (t && c) return `${t}\n\n${c}`;
  return t || c || 'Новая заметка';
}

export interface AppSidebarProps {
  activeSection: 'chat' | 'channels' | 'settings' | 'admin';
  user?: AppSidebarUser | null;
  threadTitle?: string | null;
  activeThreadId?: string | null;
  onNewChat?: () => void;
  mobileOpen?: boolean;
  onCloseMobile?: () => void;
  onOpenSettings?: () => void;
  onSelectThread?: (threadId: string) => void;
  onDeleteThread?: (threadId: string) => void;
  adminOpen?: boolean;
  onOpenAdmin?: () => void;
  onCloseAdmin?: () => void;
  initialAdminSection?: AdminSection;
}

export function AppSidebar({
  activeSection,
  user,
  threadTitle,
  activeThreadId,
  onNewChat,
  mobileOpen = false,
  onCloseMobile,
  onOpenSettings,
  onSelectThread,
  onDeleteThread,
  adminOpen,
  onOpenAdmin,
  onCloseAdmin,
  initialAdminSection = 'overview',
}: AppSidebarProps) {
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [internalAdminOpen, setInternalAdminOpen] = useState(false);
  const isAdminOpen = adminOpen !== undefined ? adminOpen : internalAdminOpen;

  const handleOpenAdmin = () => {
    if (onOpenAdmin) onOpenAdmin();
    else setInternalAdminOpen(true);
  };

  const handleCloseAdmin = () => {
    if (onCloseAdmin) onCloseAdmin();
    else setInternalAdminOpen(false);
  };
  const [activeTab, setActiveTab] = useState<'chats' | 'notes'>('chats');
  const [searchQuery, setSearchQuery] = useState('');

  // Threads state
  const [threads, setThreads] = useState<ChatThreadItem[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [threadsError, setThreadsError] = useState<string | null>(null);

  // Notes state
  const [notes, setNotes] = useState<UserNote[]>([]);
  const [notesLoading, setNotesLoading] = useState(false);
  const [notesError, setNotesError] = useState<string | null>(null);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [noteTitleInput, setNoteTitleInput] = useState('');
  const [noteContentInput, setNoteContentInput] = useState('');

  const profileMenuRef = useRef<HTMLDivElement | null>(null);
  const profileTriggerRef = useRef<HTMLButtonElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const asideRef = useRef<HTMLElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [isMobile, setIsMobile] = useState(false);

  const userId = user?.id;

  // Read collapsed state from localStorage
  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem('neyra:sidebar-collapsed') === '1');
    } catch {}
  }, []);

  // Mobile breakpoint: closed drawer must not keep focusable links.
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(max-width: 1023px)');
    const sync = () => setIsMobile(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  // Focus inside the open mobile drawer, trap Tab and restore focus on close.
  useEffect(() => {
    if (!isMobile || !mobileOpen) return;
    const node = asideRef.current;
    if (!node) return;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    const focusables = () =>
      Array.from(
        node.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input, textarea, select, [tabindex]:not([tabindex="-1"])'
        )
      ).filter((element) => element.getClientRects().length > 0);

    focusables()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseMobile?.();
        return;
      }
      if (event.key !== 'Tab') return;
      const list = focusables();
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previousFocusRef.current?.focus?.();
    };
  }, [isMobile, mobileOpen, onCloseMobile]);

  // Cmd/Ctrl+K focuses chat search from anywhere on the page.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return;
      event.preventDefault();
      if (collapsed) {
        setCollapsed(false);
        try {
          window.localStorage.setItem('neyra:sidebar-collapsed', '0');
        } catch {}
      }
      setActiveTab('chats');
      window.setTimeout(() => searchInputRef.current?.focus(), 0);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [collapsed]);

  const loadThreads = useCallback(async () => {
    if (!userId) {
      setThreads([]);
      setThreadsLoading(false);
      return;
    }
    setThreadsLoading(true);
    setThreadsError(null);
    try {
      const res = await apiListThreads();
      setThreads(
        res.items.map((t) => ({
          id: t.id,
          title: t.title || 'Диалог',
          updatedAt: t.updated_at,
          lastMessage: undefined,
        }))
      );
    } catch {
      setThreadsError('Не удалось загрузить список чатов.');
    } finally {
      setThreadsLoading(false);
    }
  }, [userId]);

  const loadNotes = useCallback(async () => {
    if (!userId) {
      setNotes([]);
      setNotesLoading(false);
      return;
    }
    setNotesLoading(true);
    setNotesError(null);
    try {
      const res = await apiListNotes();
      setNotes(
        res.items.map((n) => {
          const parsed = parseNoteText(n.text);
          return {
            id: n.id,
            title: parsed.title,
            content: parsed.content,
            updatedAt: n.updated_at,
            pinned: n.pinned,
          };
        })
      );
    } catch {
      setNotesError('Не удалось загрузить заметки.');
    } finally {
      setNotesLoading(false);
    }
  }, [userId]);

  // Initial load & one-time import on mount / user change
  useEffect(() => {
    let cancelled = false;
    async function init() {
      if (userId) {
        try {
          await importLocalStorageData(userId);
        } catch {}
      }
      if (!cancelled) {
        loadThreads();
        loadNotes();
      }
    }
    init();
    return () => {
      cancelled = true;
    };
  }, [userId, loadThreads, loadNotes]);

  // Listen for thread refresh events
  useEffect(() => {
    const handleRefresh = () => {
      loadThreads();
    };
    window.addEventListener('neyra:threads-refresh', handleRefresh);
    return () => window.removeEventListener('neyra:threads-refresh', handleRefresh);
  }, [loadThreads]);

  // Sync active thread title in list if changed
  useEffect(() => {
    if (!threadTitle || threadTitle === ru.chat || !activeThreadId) return;
    setThreads((prev) => {
      const idx = prev.findIndex((t) => t.id === activeThreadId);
      if (idx >= 0) {
        return prev.map((t) => (t.id === activeThreadId ? { ...t, title: threadTitle, updatedAt: new Date().toISOString() } : t));
      }
      return [{ id: activeThreadId, title: threadTitle, updatedAt: new Date().toISOString() }, ...prev];
    });
  }, [threadTitle, activeThreadId]);

  async function handleDeleteThread(e: React.MouseEvent, threadId: string) {
    e.stopPropagation();
    setThreads((prev) => prev.filter((t) => t.id !== threadId));
    try {
      await apiDeleteThread(threadId);
    } catch (err) {
      console.error('Failed to delete thread', err);
    }
    if (onDeleteThread) {
      onDeleteThread(threadId);
    } else if (activeThreadId === threadId) {
      onNewChat?.();
    }
  }

  function toggleCollapse() {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem('neyra:sidebar-collapsed', next ? '1' : '0');
      } catch {}
      return next;
    });
  }

  // Keyboard shortcut & outside click handler for profile menu and mobile drawer
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
      if (event.key === 'Escape') {
        if (profileMenuOpen) {
          setProfileMenuOpen(false);
          profileTriggerRef.current?.focus();
        } else if (mobileOpen && onCloseMobile) {
          onCloseMobile();
        }
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [profileMenuOpen, mobileOpen, onCloseMobile]);

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

  // Notes operations
  async function handleCreateNote() {
    try {
      const created = await apiCreateNote({ text: 'Новая заметка' });
      const parsed = parseNoteText(created.text);
      const newNote: UserNote = {
        id: created.id,
        title: parsed.title,
        content: parsed.content,
        updatedAt: created.updated_at,
        pinned: created.pinned,
      };
      setNotes((prev) => [newNote, ...prev]);
      startEditingNote(newNote);
    } catch (err) {
      console.error('Failed to create note', err);
    }
  }

  function startEditingNote(note: UserNote) {
    setEditingNoteId(note.id);
    setNoteTitleInput(note.title);
    setNoteContentInput(note.content);
  }

  async function handleSaveEditingNote() {
    if (!editingNoteId) return;
    const text = formatNoteText(noteTitleInput, noteContentInput);
    try {
      const updated = await apiUpdateNote(editingNoteId, { text });
      const parsed = parseNoteText(updated.text);
      setNotes((prev) =>
        prev.map((n) =>
          n.id === editingNoteId
            ? { ...n, title: parsed.title, content: parsed.content, updatedAt: updated.updated_at }
            : n
        )
      );
      setEditingNoteId(null);
    } catch (err) {
      console.error('Failed to save note', err);
    }
  }

  async function handleDeleteNote(noteId: string) {
    setNotes((prev) => prev.filter((n) => n.id !== noteId));
    if (editingNoteId === noteId) {
      setEditingNoteId(null);
    }
    try {
      await apiDeleteNote(noteId);
    } catch (err) {
      console.error('Failed to delete note', err);
    }
  }

  async function handleTogglePinNote(noteId: string, currentPinned: boolean) {
    try {
      await apiUpdateNote(noteId, { pinned: !currentPinned });
      loadNotes();
    } catch (err) {
      console.error('Failed to toggle pin', err);
    }
  }

  const isAdmin = user?.role === 'admin';
  const displayName = user?.name && user.name !== user.email ? user.name : user?.email || 'Пользователь';

  // Filter threads by search query
  const query = searchQuery.trim().toLowerCase();
  const filteredThreads = threads.filter((t) => {
    if (!query) return true;
    return (
      t.title.toLowerCase().includes(query) ||
      (t.lastMessage && t.lastMessage.toLowerCase().includes(query))
    );
  });

  return (
    <>
      {/* Mobile Backdrop */}
      {mobileOpen && (
        <div
          role="presentation"
          className="fixed inset-0 z-40 bg-black/60 lg:hidden backdrop-blur-sm transition-opacity"
          onClick={onCloseMobile}
          aria-hidden="true"
        />
      )}

      {/* Main Sidebar Shell */}
      <aside
        ref={asideRef}
        inert={isMobile && !mobileOpen}
        aria-hidden={isMobile && !mobileOpen ? true : undefined}
        className={`fixed lg:static z-50 inset-y-0 left-0 bg-[var(--surface)] border-r border-[var(--border)] flex flex-col justify-between transition-[transform,width] duration-150 ease-out select-none ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        } ${collapsed ? 'w-[264px] lg:w-[64px]' : 'w-[264px]'}`}
        aria-label="Боковая панель навигации"
      >
        {/* COLLAPSED RAIL (Desktop only, 64px) */}
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
                variant={activeSection === 'chat' && activeTab === 'chats' ? 'secondary' : 'ghost'}
                size="md"
                onClick={() => {
                  setActiveTab('chats');
                  if (activeSection !== 'chat') router.push('/chat');
                }}
              />
              <IconButton
                aria-label="Заметки"
                tooltip="Заметки"
                icon={<StickyNote size={16} />}
                variant={activeTab === 'notes' ? 'secondary' : 'ghost'}
                size="md"
                onClick={() => {
                  setActiveTab('notes');
                  toggleCollapse();
                }}
              />
              {isAdmin && (
                <IconButton
                  aria-label="Каналы"
                  tooltip="Каналы (Discord)"
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
                onClick={() => {
                  if (onOpenSettings) onOpenSettings();
                  else router.push('/settings');
                }}
              />
              {isAdmin && (
                <IconButton
                  aria-label="Админ-панель"
                  tooltip="Админ-панель"
                  icon={<Shield size={16} />}
                  variant={activeSection === 'admin' || isAdminOpen ? 'secondary' : 'ghost'}
                  size="md"
                  onClick={handleOpenAdmin}
                />
              )}
              <button
                ref={profileTriggerRef}
                type="button"
                aria-haspopup="menu"
                aria-expanded={profileMenuOpen}
                aria-label="Меню профиля пользователя"
                onClick={() => {
                  if (collapsed) {
                    setCollapsed(false);
                    try {
                      window.localStorage.setItem('neyra:sidebar-collapsed', '0');
                    } catch {}
                  }
                  setProfileMenuOpen(true);
                }}
                className="rounded-full p-0.5 hover:ring-2 hover:ring-[var(--border-strong)] transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              >
                <Avatar name={user?.name} email={user?.email} size={28} />
              </button>
            </div>
          </div>
        )}

        {/* EXPANDED SIDEBAR (or Mobile drawer) */}
        <div className={`flex flex-col justify-between h-full min-h-0 ${collapsed ? 'lg:hidden' : ''}`}>
          {/* Top Section */}
          <div className="p-3.5 space-y-3.5 flex-1 min-h-0 flex flex-col">
            {/* Logo row */}
            <div className="flex items-center justify-between shrink-0">
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

            {/* Action Button: Новый чат */}
            <Button
              variant="secondary"
              className="w-full justify-start gap-2 h-9 text-xs font-medium shrink-0"
              onClick={handleStartNewChat}
            >
              <Plus size={15} className="shrink-0 text-[var(--text-muted)]" />
              <span>{ru.newChat}</span>
            </Button>

            {/* Navigation Tabs: Чаты / Заметки / Каналы */}
            <div className="space-y-1 shrink-0">
              <div className="grid grid-cols-2 gap-1 p-1 bg-[var(--surface-2)] rounded-[var(--radius-sm)] border border-[var(--border)]">
                <button
                  type="button"
                  aria-selected={activeTab === 'chats'}
                  onClick={() => {
                    setActiveTab('chats');
                    if (activeSection !== 'chat') router.push('/chat');
                  }}
                  className={`flex items-center justify-center gap-1.5 py-2 sm:py-1 min-h-[40px] sm:min-h-0 text-xs font-medium rounded-[calc(var(--radius-sm)-2px)] transition-colors cursor-pointer ${
                    activeTab === 'chats'
                      ? 'bg-[var(--surface-3)] text-[var(--text)] shadow-sm'
                      : 'text-[var(--text-muted)] hover:text-[var(--text)]'
                  }`}
                >
                  <MessageSquare size={13} className="shrink-0" />
                  <span>Чаты</span>
                </button>
                <button
                  type="button"
                  aria-selected={activeTab === 'notes'}
                  onClick={() => setActiveTab('notes')}
                  className={`flex items-center justify-center gap-1.5 py-2 sm:py-1 min-h-[40px] sm:min-h-0 text-xs font-medium rounded-[calc(var(--radius-sm)-2px)] transition-colors cursor-pointer ${
                    activeTab === 'notes'
                      ? 'bg-[var(--surface-3)] text-[var(--text)] shadow-sm'
                      : 'text-[var(--text-muted)] hover:text-[var(--text)]'
                  }`}
                >
                  <StickyNote size={13} className="shrink-0" />
                  <span>Заметки</span>
                </button>
              </div>

              {isAdmin && (
                <Link
                  href="/channels"
                  className={`flex items-center gap-2 px-2.5 py-1.5 rounded-[var(--radius-sm)] text-xs font-medium transition-colors ${
                    activeSection === 'channels'
                      ? 'bg-[var(--surface-3)] text-[var(--text)] font-semibold'
                      : 'text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-2)]'
                  }`}
                >
                  <Hash size={14} className="shrink-0" />
                  <span>Каналы (Discord)</span>
                </Link>
              )}
            </div>

            {/* Content Area: Either CHATS or NOTES */}
            {activeTab === 'chats' ? (
              <div className="flex-1 min-h-0 flex flex-col space-y-2">
                {/* Search input */}
                <div className="relative shrink-0">
                  <Search
                    size={13}
                    className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-subtle)] pointer-events-none"
                  />
                  <input
                    ref={searchInputRef}
                    type="search"
                    aria-label="Поиск по чатам"
                    placeholder="Поиск по чатам…"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-[var(--radius-sm)] text-xs pl-7 pr-7 py-1.5 text-[var(--text)] placeholder-[var(--text-subtle)] outline-none focus:border-[var(--accent)]"
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      aria-label="Очистить поиск"
                      onClick={() => setSearchQuery('')}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-subtle)] hover:text-[var(--text)] p-0.5"
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>

                {/* Threads list */}
                <div className="flex-1 overflow-y-auto space-y-0.5 pr-0.5" aria-label="Список чатов">
                  {threadsLoading && threads.length === 0 ? (
                    <div className="space-y-2 p-2 animate-pulse" role="status" aria-label="Загрузка чатов">
                      <div className="h-7 bg-[var(--surface-2)] rounded-[var(--radius-sm)]" />
                      <div className="h-7 bg-[var(--surface-2)] rounded-[var(--radius-sm)]" />
                      <div className="h-7 bg-[var(--surface-2)] rounded-[var(--radius-sm)]" />
                    </div>
                  ) : threadsError ? (
                    <div className="py-6 px-3 text-center space-y-2">
                      <p className="text-xs text-[var(--danger)]">{threadsError}</p>
                      <Button variant="secondary" size="sm" onClick={loadThreads}>
                        Повторить
                      </Button>
                    </div>
                  ) : filteredThreads.length === 0 ? (
                    <div className="py-8 px-2 flex flex-col items-center text-center">
                      <div className="w-10 h-10 rounded-full bg-[var(--surface-2)] border border-[var(--border)] flex items-center justify-center text-[var(--text-subtle)] mb-2.5">
                        <MessageSquare size={17} />
                      </div>
                      <p className="text-xs font-medium text-[var(--text)]">
                        {query ? 'Ничего не найдено' : 'Пока нет чатов'}
                      </p>
                      <p className="mt-1 text-[11px] text-[var(--text-subtle)] leading-relaxed">
                        {query
                          ? 'Попробуйте другой запрос'
                          : 'Диалог появится здесь, как только вы напишете первое сообщение'}
                      </p>
                      {query ? (
                        <Button variant="secondary" size="sm" className="mt-3 min-h-11 sm:min-h-0" onClick={() => setSearchQuery('')}>
                          Сбросить поиск
                        </Button>
                      ) : (
                        <Button
                          variant="secondary"
                          size="sm"
                          className="mt-3 min-h-11 gap-1.5 sm:min-h-0"
                          onClick={handleStartNewChat}
                        >
                          <Plus size={13} />
                          <span>Начать диалог</span>
                        </Button>
                      )}
                    </div>
                  ) : (
                    filteredThreads.map((thread) => {
                      const isActive =
                        activeSection === 'chat' &&
                        (activeThreadId
                          ? thread.id === activeThreadId
                          : (thread.title === threadTitle || thread.id === 'current'));
                      return (
                        <div
                          key={thread.id}
                          className={`group relative flex items-center justify-between rounded-[var(--radius-sm)] transition-colors ${
                            isActive
                              ? 'bg-[var(--surface-3)] text-[var(--text)] border-l-2 border-[var(--accent)] font-medium'
                              : 'text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-2)]'
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() => {
                              if (onSelectThread) onSelectThread(thread.id);
                              else if (activeSection !== 'chat') router.push('/chat');
                              onCloseMobile?.();
                            }}
                            className="flex-1 min-w-0 flex items-center gap-2 px-2.5 py-2 text-xs text-left cursor-pointer"
                          >
                            <MessageSquare size={13} className="shrink-0 text-[var(--text-muted)]" />
                            <span className="truncate flex-1">{thread.title}</span>
                          </button>
                          <IconButton
                            aria-label={`Удалить ${thread.title}`}
                            tooltip="Удалить тред"
                            icon={<Trash2 size={12} />}
                            variant="ghost"
                            size="sm"
                            className="w-6 h-6 mr-1 opacity-0 group-hover:opacity-70 hover:opacity-100 hover:text-[var(--danger)] transition-opacity"
                            onClick={(e) => handleDeleteThread(e, thread.id)}
                          />
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            ) : (
              /* NOTES SECTION */
              <div className="flex-1 min-h-0 flex flex-col space-y-2">
                <div className="flex items-center justify-between shrink-0 px-0.5">
                  <div>
                    <h3 className="text-xs font-semibold text-[var(--text)]">Заметки</h3>
                    <p className="text-[10px] text-[var(--text-subtle)]">Личные заметки в базе данных</p>
                  </div>
                  <IconButton
                    aria-label="Добавить заметку"
                    tooltip="Создать заметку"
                    icon={<Plus size={14} />}
                    variant="secondary"
                    size="sm"
                    onClick={handleCreateNote}
                  />
                </div>

                {/* Inline Note Editor */}
                {editingNoteId && (
                  <div className="bg-[var(--surface-2)] border border-[var(--border)] rounded-[var(--radius-sm)] p-2.5 space-y-2 shrink-0 animate-in fade-in duration-150">
                    <input
                      type="text"
                      aria-label="Заголовок заметки"
                      placeholder="Заголовок…"
                      value={noteTitleInput}
                      onChange={(e) => setNoteTitleInput(e.target.value)}
                      className="w-full bg-[var(--surface-3)] border border-[var(--border)] rounded px-2 py-1 text-xs text-[var(--text)] font-medium outline-none focus:border-[var(--accent)]"
                    />
                    <textarea
                      aria-label="Текст заметки"
                      placeholder="Текст заметки…"
                      rows={3}
                      value={noteContentInput}
                      onChange={(e) => setNoteContentInput(e.target.value)}
                      className="w-full bg-[var(--surface-3)] border border-[var(--border)] rounded p-2 text-xs text-[var(--text)] resize-none outline-none focus:border-[var(--accent)]"
                    />
                    <div className="flex justify-end gap-1.5">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setEditingNoteId(null)}
                      >
                        Отмена
                      </Button>
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={handleSaveEditingNote}
                      >
                        <Check size={12} className="mr-1" />
                        Сохранить
                      </Button>
                    </div>
                  </div>
                )}

                {/* Notes List */}
                <div className="flex-1 overflow-y-auto space-y-1.5 pr-0.5" aria-label="Список заметок">
                  {notesLoading && notes.length === 0 ? (
                    <div className="space-y-2 p-2 animate-pulse" role="status" aria-label="Загрузка заметок">
                      <div className="h-12 bg-[var(--surface-2)] rounded-[var(--radius-sm)]" />
                      <div className="h-12 bg-[var(--surface-2)] rounded-[var(--radius-sm)]" />
                    </div>
                  ) : notesError ? (
                    <div className="py-6 px-3 text-center space-y-2">
                      <p className="text-xs text-[var(--danger)]">{notesError}</p>
                      <Button variant="secondary" size="sm" onClick={loadNotes}>
                        Повторить
                      </Button>
                    </div>
                  ) : notes.length === 0 ? (
                    <div className="py-8 px-2 flex flex-col items-center text-center">
                      <div className="w-10 h-10 rounded-full bg-[var(--surface-2)] border border-[var(--border)] flex items-center justify-center text-[var(--text-subtle)] mb-2.5">
                        <StickyNote size={17} />
                      </div>
                      <p className="text-xs font-medium text-[var(--text)]">Заметок пока нет</p>
                      <p className="mt-1 text-[11px] text-[var(--text-subtle)] leading-relaxed">
                        Короткие записи для себя — сохраняются в базе данных
                      </p>
                      <Button
                        variant="secondary"
                        size="sm"
                        className="mt-3 min-h-11 gap-1.5 sm:min-h-0"
                        onClick={handleCreateNote}
                      >
                        <Plus size={13} />
                        <span>Создать заметку</span>
                      </Button>
                    </div>
                  ) : (
                    notes.map((note) => (
                      <div
                        key={note.id}
                        className={`group relative p-2 rounded-[var(--radius-sm)] bg-[var(--surface-2)] hover:bg-[var(--surface-3)] border transition-colors text-left ${
                          note.pinned ? 'border-[var(--accent)]/40 bg-[var(--surface-2)]' : 'border-[var(--border)]'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-1">
                          <button
                            type="button"
                            onClick={() => startEditingNote(note)}
                            className="font-medium text-xs text-[var(--text)] truncate text-left flex-1 hover:underline cursor-pointer flex items-center gap-1.5"
                          >
                            {note.pinned && (
                              <Pin size={11} className="shrink-0 text-[var(--accent)] fill-current" />
                            )}
                            <span className="truncate">{note.title}</span>
                          </button>
                          <div className="flex items-center gap-0.5 opacity-60 group-hover:opacity-100 transition-opacity">
                            <IconButton
                              aria-label={note.pinned ? 'Открепить заметку' : 'Закрепить заметку'}
                              tooltip={note.pinned ? 'Открепить' : 'Закрепить'}
                              icon={<Pin size={12} className={note.pinned ? 'fill-current text-[var(--accent)]' : ''} />}
                              size="sm"
                              className={`w-6 h-6 ${note.pinned ? 'opacity-100 text-[var(--accent)]' : ''}`}
                              onClick={() => handleTogglePinNote(note.id, Boolean(note.pinned))}
                            />
                            <IconButton
                              aria-label="Редактировать заметку"
                              tooltip="Редактировать"
                              icon={<Edit2 size={12} />}
                              size="sm"
                              className="w-6 h-6"
                              onClick={() => startEditingNote(note)}
                            />
                            <IconButton
                              aria-label="Удалить заметку"
                              tooltip="Удалить"
                              icon={<Trash2 size={12} />}
                              variant="danger"
                              size="sm"
                              className="w-6 h-6"
                              onClick={() => handleDeleteNote(note.id)}
                            />
                          </div>
                        </div>
                        {note.content && (
                          <p className="text-[11px] text-[var(--text-muted)] line-clamp-2 mt-1 whitespace-pre-wrap">
                            {note.content}
                          </p>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Bottom Section: User Profile & Popover */}
          <div className="relative border-t border-[var(--border)] p-3 bg-[var(--surface)] shrink-0">
            <button
              ref={profileTriggerRef}
              type="button"
              aria-haspopup="menu"
              aria-expanded={profileMenuOpen}
              aria-label="Меню профиля пользователя"
              onClick={() => setProfileMenuOpen((prev) => !prev)}
              className="w-full min-h-[44px] flex items-center justify-between gap-2 p-1.5 rounded-[var(--radius-sm)] hover:bg-[var(--surface-2)] transition-colors text-left cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
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
                  onClick={(event) => {
                    setProfileMenuOpen(false);
                    if (onOpenSettings) {
                      event.preventDefault();
                      onOpenSettings();
                    }
                  }}
                  className="w-full min-h-[44px] sm:min-h-0 flex items-center gap-2 px-2.5 py-2 sm:py-1.5 rounded-[var(--radius-sm)] text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-3)] transition-colors text-left"
                >
                  <Settings size={14} className="shrink-0" />
                  <span>Настройки</span>
                </Link>

                {isAdmin && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setProfileMenuOpen(false);
                      handleOpenAdmin();
                    }}
                    className="w-full min-h-[44px] sm:min-h-0 flex items-center gap-2 px-2.5 py-2 sm:py-1.5 rounded-[var(--radius-sm)] text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-3)] transition-colors text-left cursor-pointer"
                  >
                    <Shield size={14} className="shrink-0" />
                    <span>Админ-панель</span>
                  </button>
                )}

                <button
                  type="button"
                  role="menuitem"
                  onClick={async () => {
                    setProfileMenuOpen(false);
                    await signOut();
                    router.push('/login');
                  }}
                  className="w-full min-h-[44px] sm:min-h-0 flex items-center gap-2 px-2.5 py-2 sm:py-1.5 rounded-[var(--radius-sm)] text-[var(--danger)] hover:bg-[var(--danger-quiet)] transition-colors text-left cursor-pointer"
                >
                  <LogOut size={14} className="shrink-0" />
                  <span>{ru.signOut}</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </aside>

      {/* Admin Dialog Modal */}
      {isAdmin && (
        <AdminDialog
          open={isAdminOpen}
          onClose={handleCloseAdmin}
          initialSection={initialAdminSection}
          user={user}
        />
      )}
    </>
  );
}
