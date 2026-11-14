'use client';

import { useEffect, useRef, type ReactNode } from 'react';

// Нативный <dialog>: фокус-ловушка, Escape и подложка — без сторонних библиотек.
export function Dialog({ open, title, onClose, children }: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={onClose}
      aria-label={title}
      className="w-[min(560px,calc(100vw-2rem))] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--background)] p-0 text-[var(--foreground)] backdrop:bg-black/60"
    >
      <div className="border-b border-[var(--border)] px-4 py-3">
        <h2 className="text-sm font-semibold">{title}</h2>
      </div>
      <div className="px-4 py-4 text-sm">{children}</div>
    </dialog>
  );
}
