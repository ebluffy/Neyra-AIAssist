'use client';

import { useEffect, useRef, type ReactNode } from 'react';

// Нативный <dialog>: фокус-ловушка, Escape и подложка
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
      className="w-[min(560px,calc(100vw-2rem))] rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--surface-2)] p-0 text-[var(--text)] shadow-panel backdrop:bg-black/75"
    >
      <div className="border-b border-[var(--border)] px-5 py-3.5 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-[var(--text)]">{title}</h2>
      </div>
      <div className="px-5 py-4 text-sm text-[var(--text)]">{children}</div>
    </dialog>
  );
}
