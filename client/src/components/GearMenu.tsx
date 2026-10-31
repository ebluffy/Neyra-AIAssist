import { useEffect, useRef } from 'react';
import { SHEETS, THEMES, type SheetId, type ThemeId } from '../theme';

interface Props {
  open: boolean;
  theme: ThemeId;
  onClose: () => void;
  onNewChat: () => void;
  onHistory: () => void;
  onSheet: (id: SheetId) => void;
  onTheme: (id: ThemeId) => void;
  onStop: () => void;
}

export function GearMenu({ open, theme, onClose, onNewChat, onHistory, onSheet, onTheme, onStop }: Props) {
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
    <button type="button" onClick={onNewChat}>Новый чат</button>
    <button type="button" onClick={onHistory}>История</button>
    <hr />
    {SHEETS.filter(item => item.id !== 'settings' && item.id !== 'status' && item.id !== 'updates' && item.id !== 'about').map(item => <button type="button" key={item.id} onClick={() => onSheet(item.id)}>{item.label}</button>)}
    <fieldset>
      <legend>Тема</legend>
      {THEMES.map(item => <label key={item.id}><input type="radio" name="menu-theme" value={item.id} checked={theme === item.id} onChange={() => onTheme(item.id)} />{item.label}</label>)}
    </fieldset>
    <button type="button" onClick={() => onSheet('settings')}>Настройки</button>
    <button type="button" onClick={() => onSheet('status')}>Состояние и модули</button>
    <button type="button" onClick={() => onSheet('updates')}>Обновления</button>
    <button type="button" onClick={() => onSheet('about')}>О программе</button>
    <hr />
    <button type="button" className="stop" onClick={onStop}>Стоп</button>
  </div>;
}
