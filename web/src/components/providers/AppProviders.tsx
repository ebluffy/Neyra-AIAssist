'use client';

import React, { useState, useEffect, type ReactNode } from 'react';
import { ContextMenuProvider } from '../ui/ContextMenu';
import { ToastHost } from '../ui/ToastHost';
import { Dialog } from '../ui/Dialog';
import { Kbd } from '../ui/Kbd';
import { WifiOff } from 'lucide-react';

export function AppProviders({ children }: { children: ReactNode }) {
  const [isOffline, setIsOffline] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  useEffect(() => {
    const handleOnline = () => setIsOffline(false);
    const handleOffline = () => setIsOffline(true);

    if (typeof window !== 'undefined') {
      setIsOffline(!window.navigator.onLine);
      window.addEventListener('online', handleOnline);
      window.addEventListener('offline', handleOffline);
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      // Do not open shortcuts if typing in input or textarea
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }

      if (e.key === '?' || (e.shiftKey && e.key === '/')) {
        e.preventDefault();
        setShortcutsOpen((prev) => !prev);
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  return (
    <ContextMenuProvider>
      {/* Offline Status Banner */}
      {isOffline && (
        <div
          role="status"
          aria-live="polite"
          className="fixed top-0 inset-x-0 z-50 bg-[var(--danger)] text-white text-xs font-medium py-1 px-3 flex items-center justify-center gap-2 shadow-sm animate-in fade-in slide-in-from-top duration-150"
        >
          <WifiOff size={14} className="shrink-0" />
          <span>Нет подключения к сети. Переподключаемся…</span>
        </div>
      )}

      {children}

      <ToastHost />

      {/* Keyboard Shortcuts Dialog (?) */}
      <Dialog
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
        title="Горячие клавиши Neyra"
        description="Быстрые команды для комфортной работы в интерфейсе"
      >
        <div className="space-y-4 text-xs">
          <div className="space-y-2">
            <h4 className="font-semibold text-[var(--text)] uppercase tracking-wider text-[10px] text-[var(--text-subtle)]">
              Навигация и поиск
            </h4>
            <div className="grid grid-cols-2 gap-2">
              <div className="flex items-center justify-between p-2 rounded-[var(--radius-sm)] bg-[var(--surface-3)]">
                <span>Быстрый поиск по чатам</span>
                <Kbd>⌘K / Ctrl+K</Kbd>
              </div>
              <div className="flex items-center justify-between p-2 rounded-[var(--radius-sm)] bg-[var(--surface-3)]">
                <span>Справка по клавишам</span>
                <Kbd>?</Kbd>
              </div>
              <div className="flex items-center justify-between p-2 rounded-[var(--radius-sm)] bg-[var(--surface-3)]">
                <span>Свернуть / развернуть меню</span>
                <Kbd>⌘B / Ctrl+B</Kbd>
              </div>
              <div className="flex items-center justify-between p-2 rounded-[var(--radius-sm)] bg-[var(--surface-3)]">
                <span>Контекстное меню</span>
                <Kbd>ПКМ / ⇧F10</Kbd>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <h4 className="font-semibold text-[var(--text)] uppercase tracking-wider text-[10px] text-[var(--text-subtle)]">
              Диалог и сообщения
            </h4>
            <div className="grid grid-cols-2 gap-2">
              <div className="flex items-center justify-between p-2 rounded-[var(--radius-sm)] bg-[var(--surface-3)]">
                <span>Отправить сообщение</span>
                <Kbd>Enter</Kbd>
              </div>
              <div className="flex items-center justify-between p-2 rounded-[var(--radius-sm)] bg-[var(--surface-3)]">
                <span>Перенос строки</span>
                <Kbd>Shift+Enter</Kbd>
              </div>
              <div className="flex items-center justify-between p-2 rounded-[var(--radius-sm)] bg-[var(--surface-3)]">
                <span>Прервать ответ</span>
                <Kbd>Escape</Kbd>
              </div>
              <div className="flex items-center justify-between p-2 rounded-[var(--radius-sm)] bg-[var(--surface-3)]">
                <span>Новый диалог</span>
                <Kbd>⌘O / Ctrl+O</Kbd>
              </div>
            </div>
          </div>
        </div>
      </Dialog>
    </ContextMenuProvider>
  );
}
