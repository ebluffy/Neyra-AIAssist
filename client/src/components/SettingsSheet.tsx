import { useEffect, useRef, type ReactNode } from 'react';
import { SHEETS, type SheetId } from '../theme';
import { CloseIcon } from '../icons';

interface Props {
  section: SheetId;
  onSection: (id: SheetId) => void;
  onClose: () => void;
  children: ReactNode;
}

export function SettingsSheet({ section, onSection, onClose, children }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; });
  useEffect(() => {
    const root = panel.current;
    const previous = document.activeElement as HTMLElement | null;
    const focusable = () => [...(root?.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') ?? [])].filter(node => !node.hasAttribute('disabled') && !node.closest('dialog') && !node.classList.contains('backdrop-dismiss'));
    focusable()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement | null)?.closest('dialog')) return;
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); return; }
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    root?.addEventListener('keydown', onKey);
    return () => { root?.removeEventListener('keydown', onKey); previous?.focus(); };
  }, [section]);
  return <div className="backdrop">
    <button type="button" className="backdrop-dismiss" aria-label="Закрыть панель" onClick={onClose} />
    <div className="sheet" ref={panel} role="dialog" aria-modal="true" aria-label={SHEETS.find(item => item.id === section)?.label ?? 'Настройки'}>
      <nav className="sheet-nav" aria-label="Разделы настроек">
        <button type="button" className="icon" aria-label="Закрыть" onClick={onClose}><CloseIcon /></button>
        {SHEETS.map(item => <button type="button" key={item.id} aria-current={item.id === section ? 'page' : undefined} onClick={() => onSection(item.id)}>{item.label}</button>)}
      </nav>
      <div className="sheet-body">
        {children}
      </div>
    </div>
  </div>;
}
