import { useEffect, useRef } from 'react';
import { History, SlidersHorizontal, SquarePen } from 'lucide-react';

interface Props {
  open: boolean;
  onClose: () => void;
  onNewChat: () => void;
  onHistory: () => void;
  onSettings: () => void;
}

export function GearMenu({ open, onClose, onNewChat, onHistory, onSettings }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; });
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node)) closeRef.current(); };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); } };
    const timer = window.setTimeout(() => window.addEventListener('pointerdown', onPointer), 0);
    window.addEventListener('keydown', onKey);
    panel.current?.querySelector('button')?.focus();
    return () => { window.clearTimeout(timer); window.removeEventListener('pointerdown', onPointer); window.removeEventListener('keydown', onKey); };
  }, [open]);
  if (!open) return null;
  return <div className="menu" id="gear-menu" ref={panel} role="group" aria-label="Меню">
    <button type="button" onClick={onNewChat}><SquarePen size={18} strokeWidth={1.75} aria-hidden="true" />Новый чат</button>
    <button type="button" onClick={onHistory}><History size={18} strokeWidth={1.75} aria-hidden="true" />История</button>
    <button type="button" onClick={onSettings}><SlidersHorizontal size={18} strokeWidth={1.75} aria-hidden="true" />Настройки</button>
  </div>;
}
