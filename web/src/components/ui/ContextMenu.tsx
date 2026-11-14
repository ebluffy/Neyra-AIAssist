'use client';

import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  useCallback,
  type ReactNode,
} from 'react';
import {
  MessageSquare,
  Edit2,
  Pin,
  FolderPlus,
  Copy,
  Share2,
  Download,
  Archive,
  Trash2,
  FileText,
  Tag,
  ChevronDown,
  FileCode,
  Quote,
  GitBranch,
  RotateCw,
  Volume2,
  ThumbsUp,
  ExternalLink,
  CheckSquare,
  Clipboard,
  Paperclip,
  Image as ImageIcon,
  Eraser,
  Maximize2,
  Send,
  Sliders,
  Link,
  ToggleRight,
  CheckCircle,
  Hash,
  ArrowUpNarrowWide,
  EyeOff,
  RotateCcw,
  Ban,
  RefreshCw,
  User,
  Link2,
  Palette,
  LogOut,
  ShieldAlert,
  Compass,
  Search,
  MessageSquarePlus,
} from 'lucide-react';
import { getMenu, type MenuItem, type MenuTarget } from '../../lib/context-menu/registry';
import { soonToast } from '../../lib/toast';
import { isEnabled } from '../../lib/feature-flags';
import { playButtonClickSound } from '../../lib/ui-sounds';

const ICON_MAP: Record<string, React.ReactNode> = {
  MessageSquare: <MessageSquare size={15} />,
  Edit2: <Edit2 size={15} />,
  Pin: <Pin size={15} />,
  FolderPlus: <FolderPlus size={15} />,
  Copy: <Copy size={15} />,
  Share2: <Share2 size={15} />,
  Download: <Download size={15} />,
  Archive: <Archive size={15} />,
  Trash2: <Trash2 size={15} />,
  FileText: <FileText size={15} />,
  Tag: <Tag size={15} />,
  ChevronDown: <ChevronDown size={15} />,
  FileCode: <FileCode size={15} />,
  Quote: <Quote size={15} />,
  GitBranch: <GitBranch size={15} />,
  RotateCw: <RotateCw size={15} />,
  Volume2: <Volume2 size={15} />,
  ThumbsUp: <ThumbsUp size={15} />,
  ExternalLink: <ExternalLink size={15} />,
  CheckSquare: <CheckSquare size={15} />,
  Clipboard: <Clipboard size={15} />,
  Paperclip: <Paperclip size={15} />,
  Image: <ImageIcon size={15} />,
  Eraser: <Eraser size={15} />,
  Maximize2: <Maximize2 size={15} />,
  Send: <Send size={15} />,
  Sliders: <Sliders size={15} />,
  Link: <Link size={15} />,
  ToggleRight: <ToggleRight size={15} />,
  CheckCircle: <CheckCircle size={15} />,
  Hash: <Hash size={15} />,
  ArrowUpNarrowWide: <ArrowUpNarrowWide size={15} />,
  EyeOff: <EyeOff size={15} />,
  RotateCcw: <RotateCcw size={15} />,
  Ban: <Ban size={15} />,
  RefreshCw: <RefreshCw size={15} />,
  User: <User size={15} />,
  Link2: <Link2 size={15} />,
  Palette: <Palette size={15} />,
  LogOut: <LogOut size={15} />,
  ShieldAlert: <ShieldAlert size={15} />,
  Compass: <Compass size={15} />,
  Search: <Search size={15} />,
  MessageSquarePlus: <MessageSquarePlus size={15} />,
};

interface ContextMenuState {
  open: boolean;
  x: number;
  y: number;
  target: MenuTarget;
  items: MenuItem[];
}

interface ContextMenuContextType {
  openMenu: (x: number, y: number, target: MenuTarget) => void;
  closeMenu: () => void;
}

const ContextMenuContext = createContext<ContextMenuContextType | null>(null);

export function useContextMenu() {
  const ctx = useContext(ContextMenuContext);
  if (!ctx) throw new Error('useContextMenu must be used within ContextMenuProvider');
  return ctx;
}

export function ContextMenuProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ContextMenuState>({
    open: false,
    x: 0,
    y: 0,
    target: { kind: 'none' },
    items: [],
  });

  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const activeIndexRef = useRef<number>(-1);
  const touchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchStartPos = useRef<{ x: number; y: number } | null>(null);

  const closeMenu = useCallback(() => {
    setState((prev) => (prev.open ? { ...prev, open: false } : prev));
    if (triggerRef.current) {
      triggerRef.current.focus?.();
    }
  }, []);

  const openMenu = useCallback((x: number, y: number, target: MenuTarget) => {
    const items = getMenu(target.kind, target);
    if (!items || items.length === 0) return;

    triggerRef.current = target.element || (document.activeElement as HTMLElement | null);
    activeIndexRef.current = -1;

    setState({
      open: true,
      x,
      y,
      target,
      items,
    });
    playButtonClickSound();
  }, []);

  // Global ContextMenu handler
  useEffect(() => {
    function handleContextMenu(e: MouseEvent) {
      // Shift+Right click -> open native menu
      if (e.shiftKey) return;

      // Check user preference in settings
      const mode = window.localStorage?.getItem('neyra:context-menu-mode');
      if (mode === 'system') return;

      const targetEl = e.target as HTMLElement | null;
      if (!targetEl) return;

      // DO NOT override in text inputs or code pre blocks with selection
      if (
        targetEl.tagName === 'INPUT' ||
        targetEl.tagName === 'TEXTAREA' ||
        targetEl.isContentEditable ||
        targetEl.closest('input, textarea, [contenteditable="true"]')
      ) {
        return;
      }

      const preBlock = targetEl.closest('pre');
      const selection = window.getSelection()?.toString().trim();
      if (preBlock && selection) {
        return;
      }

      // Check if text is selected anywhere on page
      if (selection && selection.length > 0) {
        e.preventDefault();
        openMenu(e.clientX, e.clientY, {
          kind: 'selection',
          text: selection,
          element: targetEl,
        });
        return;
      }

      // Check explicit data-context
      const contextEl = targetEl.closest<HTMLElement>('[data-context]');
      if (contextEl) {
        e.preventDefault();
        const kind = contextEl.getAttribute('data-context') || '';
        const id = contextEl.getAttribute('data-id') || undefined;
        const title = contextEl.getAttribute('data-title') || undefined;
        const role = (contextEl.getAttribute('data-role') as 'user' | 'assistant') || undefined;
        const text = contextEl.getAttribute('data-text') || contextEl.textContent || undefined;
        const count = contextEl.getAttribute('data-selected-count')
          ? parseInt(contextEl.getAttribute('data-selected-count')!, 10)
          : undefined;

        openMenu(e.clientX, e.clientY, {
          kind,
          id,
          title,
          role,
          text,
          selectedCount: count,
          element: contextEl,
        });
        return;
      }

      // Check anchor tag
      const anchorEl = targetEl.closest<HTMLAnchorElement>('a[href]');
      if (anchorEl) {
        e.preventDefault();
        openMenu(e.clientX, e.clientY, {
          kind: 'link',
          url: anchorEl.href,
          text: anchorEl.textContent || undefined,
          element: anchorEl,
        });
        return;
      }

      // Check image
      if (targetEl.tagName === 'IMG' || targetEl.closest('img')) {
        const img = (targetEl.tagName === 'IMG' ? targetEl : targetEl.closest('img')) as HTMLImageElement;
        e.preventDefault();
        openMenu(e.clientX, e.clientY, {
          kind: 'image',
          url: img.src,
          title: img.alt || undefined,
          element: img,
        });
        return;
      }

      // Empty space / unannotated area -> fallback to native behavior
    }

    // Touch support: 500ms long press
    function handleTouchStart(e: TouchEvent) {
      if (e.touches.length !== 1) return;
      const touch = e.touches[0];
      touchStartPos.current = { x: touch.clientX, y: touch.clientY };

      touchTimerRef.current = setTimeout(() => {
        const targetEl = document.elementFromPoint(touch.clientX, touch.clientY) as HTMLElement | null;
        if (!targetEl) return;
        const contextEl = targetEl.closest<HTMLElement>('[data-context]');
        if (contextEl) {
          const kind = contextEl.getAttribute('data-context') || '';
          openMenu(touch.clientX, touch.clientY, {
            kind,
            id: contextEl.getAttribute('data-id') || undefined,
            title: contextEl.getAttribute('data-title') || undefined,
            element: contextEl,
          });
        }
      }, 500);
    }

    function handleTouchMove(e: TouchEvent) {
      if (!touchStartPos.current || e.touches.length !== 1) return;
      const touch = e.touches[0];
      const dx = Math.abs(touch.clientX - touchStartPos.current.x);
      const dy = Math.abs(touch.clientY - touchStartPos.current.y);
      if (dx > 10 || dy > 10) {
        if (touchTimerRef.current) clearTimeout(touchTimerRef.current);
        touchTimerRef.current = null;
      }
    }

    function handleTouchEnd() {
      if (touchTimerRef.current) {
        clearTimeout(touchTimerRef.current);
        touchTimerRef.current = null;
      }
      touchStartPos.current = null;
    }

    // Keyboard support: "ContextMenu" key or Shift+F10
    function handleGlobalKeyDown(e: KeyboardEvent) {
      if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
        const active = document.activeElement as HTMLElement | null;
        if (active) {
          const contextEl = active.closest<HTMLElement>('[data-context]');
          if (contextEl) {
            e.preventDefault();
            const rect = contextEl.getBoundingClientRect();
            openMenu(rect.left + 24, rect.bottom, {
              kind: contextEl.getAttribute('data-context') || '',
              id: contextEl.getAttribute('data-id') || undefined,
              title: contextEl.getAttribute('data-title') || undefined,
              element: contextEl,
            });
          }
        }
      }
    }

    window.addEventListener('contextmenu', handleContextMenu);
    window.addEventListener('touchstart', handleTouchStart, { passive: true });
    window.addEventListener('touchmove', handleTouchMove, { passive: true });
    window.addEventListener('touchend', handleTouchEnd);
    window.addEventListener('keydown', handleGlobalKeyDown);

    return () => {
      window.removeEventListener('contextmenu', handleContextMenu);
      window.removeEventListener('touchstart', handleTouchStart);
      window.removeEventListener('touchmove', handleTouchMove);
      window.removeEventListener('touchend', handleTouchEnd);
      window.removeEventListener('keydown', handleGlobalKeyDown);
    };
  }, [openMenu]);

  // Close handlers: outside click, Escape, scroll, resize
  useEffect(() => {
    if (!state.open) return;

    function handlePointerDown(e: PointerEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        closeMenu();
      }
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMenu();
        return;
      }

      const items = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
      if (!items || items.length === 0) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        activeIndexRef.current = (activeIndexRef.current + 1) % items.length;
        items[activeIndexRef.current]?.focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        activeIndexRef.current = (activeIndexRef.current - 1 + items.length) % items.length;
        items[activeIndexRef.current]?.focus();
      } else if (e.key === 'Home') {
        e.preventDefault();
        activeIndexRef.current = 0;
        items[0]?.focus();
      } else if (e.key === 'End') {
        e.preventDefault();
        activeIndexRef.current = items.length - 1;
        items[items.length - 1]?.focus();
      }
    }

    function handleScrollOrResize() {
      closeMenu();
    }

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('scroll', handleScrollOrResize, true);
    window.addEventListener('resize', handleScrollOrResize);

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('scroll', handleScrollOrResize, true);
      window.removeEventListener('resize', handleScrollOrResize);
    };
  }, [state.open, closeMenu]);

  // Clamped position calculation
  let posX = state.x;
  let posY = state.y;
  if (typeof window !== 'undefined') {
    const MENU_WIDTH = 260;
    const ESTIMATED_HEIGHT = Math.min(state.items.length * 34 + 20, 420);
    if (posX + MENU_WIDTH > window.innerWidth - 8) {
      posX = Math.max(8, window.innerWidth - MENU_WIDTH - 8);
    }
    if (posY + ESTIMATED_HEIGHT > window.innerHeight - 8) {
      posY = Math.max(8, window.innerHeight - ESTIMATED_HEIGHT - 8);
    }
  }

  return (
    <ContextMenuContext.Provider value={{ openMenu, closeMenu }}>
      {children}
      {state.open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Контекстное меню"
          style={{
            position: 'fixed',
            left: `${posX}px`,
            top: `${posY}px`,
            zIndex: 9999,
          }}
          className="w-[260px] max-h-[calc(100vh-32px)] overflow-y-auto bg-[var(--surface-2)] border border-[var(--border-control)] rounded-[var(--radius)] shadow-2xl p-1.5 text-xs text-[var(--text)] select-none animate-in fade-in zoom-in-95 duration-100 focus:outline-none"
        >
          {state.items.map((item, index) => {
            if (item.separator) {
              return <div key={`sep-${index}`} className="my-1 border-t border-[var(--border)]" />;
            }

            const isStub = item.flag ? !isEnabled(item.flag) : false;

            return (
              <button
                key={item.id}
                role="menuitem"
                type="button"
                tabIndex={-1}
                aria-disabled={isStub ? 'true' : undefined}
                aria-keyshortcuts={item.shortcut}
                title={isStub ? `Скоро: ${item.label}` : undefined}
                onClick={(e) => {
                  e.stopPropagation();
                  playButtonClickSound();
                  closeMenu();
                  if (isStub) {
                    soonToast(item.label);
                  } else {
                    item.run?.(state.target);
                  }
                }}
                className={`w-full h-8 px-2 flex items-center justify-between rounded-[calc(var(--radius-sm)-2px)] transition-colors cursor-pointer text-left ${
                  item.danger
                    ? 'text-[var(--danger)] hover:bg-[var(--danger-quiet)] focus-visible:bg-[var(--danger-quiet)]'
                    : 'text-[var(--text)] hover:bg-[var(--surface-3)] focus-visible:bg-[var(--surface-3)]'
                } ${isStub ? 'opacity-60 cursor-not-allowed' : ''}`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  {item.iconName && (
                    <span className="shrink-0 text-[var(--text-muted)]">
                      {ICON_MAP[item.iconName] || <MessageSquare size={15} />}
                    </span>
                  )}
                  <span className="truncate">{item.label}</span>
                </div>
                <div className="flex items-center gap-1.5 ml-2 shrink-0">
                  {isStub && (
                    <span className="text-[10px] uppercase font-mono px-1 py-0.2 rounded bg-[var(--surface-3)] text-[var(--text-subtle)]">
                      Скоро
                    </span>
                  )}
                  {item.shortcut && (
                    <kbd className="text-[10px] font-mono text-[var(--text-subtle)] bg-[var(--surface-3)] px-1 py-0.5 rounded">
                      {item.shortcut}
                    </kbd>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </ContextMenuContext.Provider>
  );
}
