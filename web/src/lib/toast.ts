'use client';

import { useState, useEffect, useCallback } from 'react';

export interface ToastItem {
  id: string;
  title?: string;
  message: string;
  tone?: 'info' | 'success' | 'danger';
  duration?: number;
}

type ToastListener = (toasts: ToastItem[]) => void;

let activeToasts: ToastItem[] = [];
const listeners = new Set<ToastListener>();

function notify() {
  listeners.forEach((listener) => listener([...activeToasts]));
}

export function emitToast(toast: Omit<ToastItem, 'id'>): string {
  const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const item: ToastItem = { ...toast, id };
  activeToasts = [...activeToasts, item];
  notify();

  const duration = toast.duration ?? 3500;
  if (duration > 0) {
    setTimeout(() => {
      dismissToast(id);
    }, duration);
  }

  return id;
}

export function dismissToast(id: string): void {
  activeToasts = activeToasts.filter((t) => t.id !== id);
  notify();
}

export function soonToast(featureName: string, description?: string): void {
  emitToast({
    title: 'Скоро',
    message: description
      ? `${featureName}: ${description}`
      : `Функция «${featureName}» появится в ближайших обновлениях`,
    tone: 'info',
  });
}

export function useToast() {
  const [toasts, setToasts] = useState<ToastItem[]>(activeToasts);

  useEffect(() => {
    listeners.add(setToasts);
    return () => {
      listeners.delete(setToasts);
    };
  }, []);

  const toast = useCallback(
    (message: string, options?: { title?: string; tone?: 'info' | 'success' | 'danger'; duration?: number }) => {
      return emitToast({
        message,
        title: options?.title,
        tone: options?.tone || 'info',
        duration: options?.duration,
      });
    },
    []
  );

  return { toasts, toast, soonToast, dismissToast };
}
