'use client';

import React from 'react';
import { useToast } from '../../lib/toast';
import { Toast } from './Toast';

export function ToastHost() {
  const { toasts, dismissToast } = useToast();

  if (toasts.length === 0) return null;

  return (
    <div
      aria-live="polite"
      aria-label="Уведомления"
      className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm pointer-events-none"
    >
      {toasts.map((t) => (
        <div key={t.id} className="pointer-events-auto">
          <Toast
            open={true}
            onClose={() => dismissToast(t.id)}
            tone={t.tone}
            title={t.title}
            message={t.message}
          />
        </div>
      ))}
    </div>
  );
}
