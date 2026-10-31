import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { formatError } from './types';

export interface CharacterSettings { schema_version: number; model: string | null; fps_limit: number; pause_fullscreen: boolean; pause_battery: boolean; always_on_top: boolean; click_through: boolean }
export interface OverlayCapabilities { transparent: string; always_on_top: string; click_through: string; exclude_from_capture: string; mechanism: string; notes: string[] }
interface CharacterState { enabled: boolean; settings: CharacterSettings; capabilities: OverlayCapabilities; models: string[]; overlay_open: boolean; renderer: string; directory: string }

const support: Record<string, string> = { yes: 'да', not_guaranteed: 'не гарантировано', no: 'нет' };
export const capabilityLabel = (value: string) => support[value] ?? 'неизвестно';

export function CharacterPanel() {
  const [state, setState] = useState<CharacterState>();
  const [draft, setDraft] = useState<CharacterSettings>();
  const [message, setMessage] = useState('');
  const apply = (next: CharacterState) => { setState(next); setDraft(next.settings); };
  const run = useCallback(async (action: () => Promise<CharacterState>) => {
    try { apply(await action()); setMessage(''); } catch (error) { setMessage(formatError(error)); }
  }, []);
  useEffect(() => {
    let live = true;
    invoke<CharacterState>('character_state')
      .then(next => { if (live) { setState(next); setDraft(next.settings); } })
      .catch(error => { if (live) setMessage(formatError(error)); });
    return () => { live = false; };
  }, []);
  if (!state || !draft) return <section aria-labelledby="character-title"><h2 id="character-title">Персонаж</h2><p role="status">{message || 'Загружаю…'}</p></section>;
  const caps = state.capabilities;
  return <section aria-labelledby="character-title">
    <h2 id="character-title">Персонаж (бета, выключен по умолчанию)</h2>
    <p>3D-движок не загружается, пока персонаж выключен. Сейчас окно показывает заглушку без VRM; отрисовка модели ещё не реализована.</p>
    {message && <p role="alert" className="error">{message}</p>}
    <p role="status">{state.enabled ? 'Персонаж включён в настройках выше.' : 'Персонаж выключен. Включите его в настройках выше и сохраните.'}</p>
    <label>Файл модели .vrm<select value={draft.model ?? ''} onChange={e => setDraft({ ...draft, model: e.target.value || null })}><option value="">Не выбрана</option>{state.models.map(name => <option key={name} value={name}>{name}</option>)}</select></label>
    <p className="path">Папка моделей и лицензий: {state.directory}</p>
    <label>Лимит FPS<input type="number" min={10} max={60} value={draft.fps_limit} onChange={e => setDraft({ ...draft, fps_limit: Number(e.target.value) })}/></label>
    <label className="check"><input type="checkbox" checked={draft.always_on_top} onChange={e => setDraft({ ...draft, always_on_top: e.target.checked })}/>Поверх окон</label>
    <label className="check"><input type="checkbox" checked={draft.click_through} onChange={e => setDraft({ ...draft, click_through: e.target.checked })}/>Клики проходят сквозь окно</label>
    <label className="check"><input type="checkbox" checked={draft.pause_fullscreen} onChange={e => setDraft({ ...draft, pause_fullscreen: e.target.checked })}/>Пауза при полноэкранном приложении</label>
    <label className="check"><input type="checkbox" checked={draft.pause_battery} onChange={e => setDraft({ ...draft, pause_battery: e.target.checked })}/>Пауза на батарее</label>
    <h3>Возможности этой сессии ({caps.mechanism})</h3>
    <ul>
      <li>Прозрачность: {capabilityLabel(caps.transparent)}</li>
      <li>Поверх окон: {capabilityLabel(caps.always_on_top)}</li>
      <li>Клики сквозь окно: {capabilityLabel(caps.click_through)}</li>
      <li>Скрыт со скриншотов: {capabilityLabel(caps.exclude_from_capture)}</li>
    </ul>
    {caps.notes.map(note => <p key={note} role="note">{note}</p>)}
    <div className="actions">
      <button onClick={() => void run(() => invoke<CharacterState>('character_save', { settings: draft }))}>Сохранить</button>
      <button disabled={!state.enabled} onClick={() => void run(() => invoke<CharacterState>('character_overlay', { show: !state.overlay_open }))}>{state.overlay_open ? 'Скрыть окно' : 'Показать окно'}</button>
    </div>
  </section>;
}
