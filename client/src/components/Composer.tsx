import { useEffect, useRef } from 'react';
import { composerSlot } from '../chat';
import { MicIcon, WaveIcon } from '../icons';

interface Props {
  text: string;
  connected: boolean;
  busy: boolean;
  turnBusy: boolean;
  liveBlocked: boolean;
  onText: (value: string) => void;
  onSend: () => void;
  onRecord: () => void;
  onLive: () => void;
  onStop: () => void;
}

export function Composer({ text, connected, busy, turnBusy, liveBlocked, onText, onSend, onRecord, onLive, onStop }: Props) {
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const field = box.current;
    if (!field) return;
    field.style.height = '0px';
    field.style.height = `${Math.min(field.scrollHeight, 160)}px`;
  }, [text]);
  const slot = composerSlot(text);
  return <form className="composer" onSubmit={event => { event.preventDefault(); if (!turnBusy && slot === 'send') onSend(); }}>
    <label className="sr-only" htmlFor="composer-input">Сообщение</label>
    <textarea id="composer-input" ref={box} rows={1} value={text} maxLength={6000} disabled={!connected} placeholder={connected ? 'Сообщение' : 'Сначала подключите сервер'} onChange={event => onText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (!turnBusy && !busy && text.trim()) onSend(); } }} />
    <button type="button" className="icon" aria-label="Записать голосовое" disabled={!connected || busy || turnBusy} onClick={onRecord}><MicIcon /></button>
    {turnBusy ? <button type="button" className="stop" onClick={onStop}>Стоп</button> : slot === 'send' ? <button type="submit" className="primary" disabled={!connected || busy}>Отправить</button> : <button type="button" className="icon live-toggle" aria-label="Начать разговор" disabled={!connected || busy || liveBlocked} title={liveBlocked ? 'В голосе выберите «Нейра» или «Слушать всегда»' : 'Разговор голосом'} onClick={onLive}><WaveIcon /></button>}
  </form>;
}
