import { useEffect, useRef } from 'react';
import { Info, Server, Settings2, UserRound, Volume2 } from 'lucide-react';
import { SHEETS, type SheetId } from '../theme';

interface Props {
  open: boolean;
  onClose: () => void;
  onSettings: (section: SheetId) => void;
  version: string;
  os: string;
}

export function GearMenu({ open, onClose, onSettings, version, os }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; });
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node) && !document.getElementById('gear')?.contains(event.target as Node)) closeRef.current(); };
    const onKey = (event: KeyboardEvent) => {
      if (!panel.current?.contains(event.target as Node)) return;
      if (event.key === 'Tab') {
        closeRef.current();
        document.getElementById('gear')?.focus();
        if (event.shiftKey) event.preventDefault();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
        document.getElementById('gear')?.focus();
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const items = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
      if (!items.length) return;
      event.preventDefault();
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    };
    const timer = window.setTimeout(() => window.addEventListener('pointerdown', onPointer), 0);
    window.addEventListener('keydown', onKey);
    const focusFirst = () => panel.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    focusFirst();
    const frame = window.requestAnimationFrame(focusFirst);
    return () => { window.cancelAnimationFrame(frame); window.clearTimeout(timer); window.removeEventListener('pointerdown', onPointer); window.removeEventListener('keydown', onKey); };
  }, [open]);
  if (!open) return null;
  return <div className="menu" id="gear-menu" ref={panel} role="menu" aria-label="Разделы настроек">
    {SHEETS.filter(item => ['voice', 'server', 'character', 'about'].includes(item.id)).map(item => {
      const Icon = item.id === 'voice' ? Volume2 : item.id === 'server' ? Server : item.id === 'character' ? UserRound : Info;
      return <button key={item.id} type="button" role="menuitem" tabIndex={-1} onClick={() => onSettings(item.id)}><Icon size={18} strokeWidth={1.75} aria-hidden="true" />{item.label}</button>;
    })}
    <button type="button" role="menuitem" tabIndex={-1} onClick={() => onSettings('settings')}><Settings2 size={18} strokeWidth={1.75} aria-hidden="true" />Настройки</button>
    <hr role="separator" />
    <p className="menu-meta" role="none">Neyra<br />{version} · {os}</p>
  </div>;
}
