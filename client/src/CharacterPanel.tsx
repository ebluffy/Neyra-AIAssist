import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { formatError } from './types';

export interface CharacterSettings { schema_version: number; model: string | null; fps_limit: number; pause_fullscreen: boolean; pause_battery: boolean; always_on_top: boolean; click_through: boolean }
export interface OverlayCapabilities { transparent: string; always_on_top: string; click_through: string; exclude_from_capture: string; mechanism: string; notes: string[] }
interface CharacterState { enabled: boolean; settings: CharacterSettings; capabilities: OverlayCapabilities; models: string[]; overlay_open: boolean; renderer: string; directory: string }

interface ModelInfo { spec: string; title: string; authors: string[]; license: string; license_url: string; redistribution: 'allowed' | 'not_allowed' | 'unknown'; size_bytes: number }
const redistribution: Record<ModelInfo['redistribution'], string> = { allowed: 'разрешено', not_allowed: 'запрещено', unknown: 'не указано' };

const support: Record<string, string> = { yes: 'да', not_guaranteed: 'не гарантировано', no: 'нет' };
export const capabilityLabel = (value: string) => support[value] ?? 'неизвестно';

export function CharacterPanel() {
  const [state, setState] = useState<CharacterState>();
  const [draft, setDraft] = useState<CharacterSettings>();
  const [message, setMessage] = useState('');
  const [loaded, setLoaded] = useState<{ name: string; value: ModelInfo | string }>();
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
  const selected = state?.settings.model ?? null;
  useEffect(() => {
    if (!selected) return;
    let live = true;
    invoke<ModelInfo>('character_model_info', { name: selected })
      .then(value => { if (live) setLoaded({ name: selected, value }); })
      .catch(error => { if (live) setLoaded({ name: selected, value: formatError(error) }); });
    return () => { live = false; };
  }, [selected]);
  const info = loaded && loaded.name === selected ? loaded.value : undefined;
  if (!state || !draft) return <section aria-labelledby="character-title"><h2 id="character-title">Персонаж</h2><p role="status">{message || 'Загружаю…'}</p></section>;
  const caps = state.capabilities;
  return <section aria-labelledby="character-title">
    <h2 id="character-title">Персонаж (бета, выключен по умолчанию)</h2>
    <p>3D-движок не загружается, пока персонаж выключен. Сейчас окно показывает заглушку без VRM; отрисовка модели ещё не реализована.</p>
    {message && <p role="alert" className="error">{message}</p>}
    <p role="status">{state.enabled ? 'Персонаж включён.' : 'Персонаж появится на шаге 7 (оверлей VRM). Пока он выключен и отсюда не включается.'}</p>
    <label>Файл модели .vrm<select value={draft.model ?? ''} onChange={e => setDraft({ ...draft, model: e.target.value || null })}><option value="">Не выбрана</option>{state.models.map(name => <option key={name} value={name}>{name}</option>)}</select></label>
    {typeof info === 'string' && <p role="alert" className="error">{info}</p>}
    {info && typeof info !== 'string' && <p role="note">Модель «{info.title || 'без названия'}»{info.authors.length > 0 && `, автор: ${info.authors.join(', ')}`}. Лицензия: {info.license || 'не указана'}. Распространение в сборке: {redistribution[info.redistribution]}. Файл остаётся на этом ПК.</p>}
    <p className="path">Папка моделей и лицензий: {state.directory}</p>
    <label>Лимит FPS<input type="number" min={10} max={60} value={draft.fps_limit} onChange={e => setDraft({ ...draft, fps_limit: Number(e.target.value) })}/></label>
    <label className="check"><input type="checkbox" checked={draft.always_on_top} onChange={e => setDraft({ ...draft, always_on_top: e.target.checked })}/>Поверх окон</label>
    <label className="check"><input type="checkbox" checked={draft.click_through} onChange={e => setDraft({ ...draft, click_through: e.target.checked })}/>Клики проходят сквозь окно</label>
    <label className="check"><input type="checkbox" checked={draft.pause_fullscreen} disabled />Пауза при полноэкранном приложении</label>
    <label className="check"><input type="checkbox" checked={draft.pause_battery} disabled />Пауза на батарее</label>
    <p className="hint">Пауза при полном экране и на батарее ещё не сделана, поэтому эти переключатели недоступны.</p>
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
