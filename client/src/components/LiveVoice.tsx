import { useEffect, useRef, useState } from 'react';
import { MessageSquare, Mic, MicOff, PhoneOff, SlidersHorizontal } from 'lucide-react';
import type { ChatMessage } from '../chat';
import { Markdown } from '../markdown';
import { liveLabel, type LiveState, type VoiceSettings } from '../types';
import { VoiceOrb } from './VoiceOrb';

interface Props {
  state: LiveState;
  mode: VoiceSettings['mode'];
  level: number;
  muted: boolean;
  busy: boolean;
  messages: ChatMessage[];
  partial: string;
  onMute: () => void;
  onSettings: () => void;
  onEnd: () => void;
}

export function LiveVoice({ state, mode, level, muted, busy, messages, partial, onMute, onSettings, onEnd }: Props) {
  const [transcript, setTranscript] = useState(false);
  const log = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const shown = muted ? 'off' : state;
  const recent = messages.slice(-8);
  useEffect(() => {
    if (transcript && log.current) log.current.scrollTop = log.current.scrollHeight;
    const node = log.current;
    if (node && follow.current) node.scrollTop = node.scrollHeight;
  }, [messages, partial, transcript]);
  return <div className="live-stage">
    <div className="live-visual">
      <div className="live-orb"><VoiceOrb state={shown} level={muted ? 0 : level} /></div>
      <p className="live-state" role="status">{liveLabel(shown, mode)}</p>
      <meter className="sr-only" aria-label="Уровень микрофона" min={0} max={1} value={muted ? 0 : level} />
    </div>
    <div className="live-transcript-layer" aria-hidden={!transcript}>
      <div className={transcript ? 'live-log open' : 'live-log'} ref={log} aria-label="Текст разговора" aria-hidden={!transcript} inert={!transcript} onScroll={event => { const node = event.currentTarget; follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 60; }}>
        {recent.length === 0 && !partial && <p className="hint">Реплики появятся здесь и останутся в этом чате.</p>}
        {recent.map(message => <article key={message.id} className={message.role}>
          <strong>{message.role === 'user' ? 'Вы' : 'Нейра'}</strong>
          {message.role === 'assistant' ? <Markdown text={message.content || '…'} /> : <p>{message.content || (message.pending ? '…' : '')}</p>}
        </article>)}
        {partial && <article className="assistant"><strong>Нейра</strong><Markdown text={partial} /></article>}
      </div>
    </div>
    <div className="live-dock">
      <div className="live-actions">
        <button type="button" className="icon" aria-pressed={muted} aria-label={muted ? 'Включить микрофон' : 'Выключить микрофон'} data-tip={muted ? 'Включить микрофон' : 'Выключить микрофон'} disabled={busy} onClick={onMute}>{muted ? <MicOff size={18} strokeWidth={1.75} aria-hidden="true" /> : <Mic size={18} strokeWidth={1.75} aria-hidden="true" />}</button>
        <button type="button" className="icon" aria-pressed={transcript} aria-expanded={transcript} aria-label="Текст разговора" data-tip="Текст разговора" onClick={() => setTranscript(open => !open)}><MessageSquare size={18} strokeWidth={1.75} aria-hidden="true" /></button>
        <button type="button" className="icon" aria-label="Настройки голоса" data-tip="Настройки голоса" disabled={busy} onClick={onSettings}><SlidersHorizontal size={18} strokeWidth={1.75} aria-hidden="true" /></button>
        <button type="button" className="icon danger" aria-label="Завершить" data-tip="Завершить" disabled={busy} onClick={onEnd}><PhoneOff size={18} strokeWidth={1.75} aria-hidden="true" /></button>
      </div>
    </div>
  </div>;
}
