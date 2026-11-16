'use client';

import React, { useState, useRef, useEffect } from 'react';
import { Download, FileText, FileCode, File, Check } from 'lucide-react';
import { Tooltip } from './Tooltip';
import { emitToast } from '../../lib/toast';

export type ExportFormat = 'markdown' | 'json' | 'pdf';

export interface ExportMenuProps {
  onExport?: (format: ExportFormat) => void;
  threadTitle?: string;
  className?: string;
}

export function ExportMenu({
  onExport,
  threadTitle = 'диалог',
  className = '',
}: ExportMenuProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [open]);

  const handleSelect = (format: ExportFormat) => {
    setOpen(false);
    if (onExport) {
      onExport(format);
    } else {
      emitToast({
        message: `Экспорт в ${format.toUpperCase()} сформирован`,
        tone: 'success',
      });
    }
  };

  return (
    <div ref={menuRef} className={`relative inline-block text-left ${className}`}>
      <Tooltip content="Экспорт диалога (MD, JSON, PDF)">
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label="Экспорт диалога"
          className="p-1.5 rounded-[var(--radius-sm)] text-[var(--text-subtle)] hover:text-[var(--text)] hover:bg-[var(--surface-3)] transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
        >
          <Download size={15} />
        </button>
      </Tooltip>

      {open && (
        <div
          role="menu"
          aria-label="Форматы экспорта"
          className="absolute right-0 top-full mt-1 z-50 w-48 rounded-[var(--radius)] bg-[var(--surface-2)] border border-[var(--border-control)] shadow-[var(--shadow-panel)] p-1 text-[var(--text)] text-xs animate-in fade-in duration-100"
        >
          <div className="px-2.5 py-1 text-[10px] uppercase font-semibold text-[var(--text-subtle)] tracking-wider">
            Экспорт в файл
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => handleSelect('markdown')}
            className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-[var(--radius-sm)] text-left hover:bg-[var(--surface-3)] transition-colors"
          >
            <FileText size={14} className="text-[var(--text-muted)]" />
            <div className="flex-1">
              <span className="font-medium">Markdown (.md)</span>
            </div>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => handleSelect('json')}
            className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-[var(--radius-sm)] text-left hover:bg-[var(--surface-3)] transition-colors"
          >
            <FileCode size={14} className="text-[var(--text-muted)]" />
            <div className="flex-1">
              <span className="font-medium">JSON (.json)</span>
            </div>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => handleSelect('pdf')}
            className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-[var(--radius-sm)] text-left hover:bg-[var(--surface-3)] transition-colors"
          >
            <File size={14} className="text-[var(--text-muted)]" />
            <div className="flex-1">
              <span className="font-medium">PDF документ (.pdf)</span>
            </div>
          </button>
        </div>
      )}
    </div>
  );
}
