import { useEffect, useRef, type ReactNode } from 'react';
import { Activity, AudioLines, Info, RefreshCw, Server, Shield, SlidersHorizontal, SquareTerminal, UserRound, X } from 'lucide-react';
import { SHEETS, type SheetId } from '../theme';

const ICONS: Record<SheetId, typeof AudioLines> = {
  voice: AudioLines,
  commands: SquareTerminal,
  permissions: Shield,
  server: Server,
  character: UserRound,
  settings: SlidersHorizontal,
  status: Activity,
  updates: RefreshCw,
  about: Info,
};

interface Props {
  section: SheetId;
  onSection: (id: SheetId) => void;
  onClose: () => void;
  onStop: () => void;
  alert?: string;
  children: ReactNode;
}

export function SettingsSheet({ section, onSection, onClose, onStop, alert, children }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; });
  useEffect(() => {
    const root = panel.current;
    const previous = document.activeElement as HTMLElement | null;
    const focusable = () => [...(root?.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') ?? [])].filter(node => !node.hasAttribute('disabled') && !node.closest('dialog'));
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
  }, []);
  return <div className="backdrop">
    <div className="sheet" ref={panel} role="dialog" aria-modal="true" aria-label="Настройки">
      <nav className="sheet-nav" aria-label="Разделы настроек">
        <button type="button" className="icon sheet-close" aria-label="Закрыть" onClick={onClose}><X size={18} strokeWidth={1.75} aria-hidden="true" /></button>
        {SHEETS.map(item => {
          const Icon = ICONS[item.id];
          return <button type="button" key={item.id} aria-current={item.id === section ? 'page' : undefined} onClick={() => onSection(item.id)}><Icon size={18} strokeWidth={1.75} aria-hidden="true" />{item.label}</button>;
        })}
        <button type="button" className="stop sheet-stop" onClick={onStop}>Стоп</button>
      </nav>
      <div className="sheet-body">{alert && <div className="error" role="alert">{alert}</div>}{children}</div>
    </div>
  </div>;
}
