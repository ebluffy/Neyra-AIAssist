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
  showStop: boolean;
  messages: ChatMessage[];
  partial: string;
  onMute: () => void;
  onSettings: () => void;
  onEnd: () => void;
  onStop: () => void;
}

export function LiveVoice({ state, mode, level, muted, busy, showStop, messages, partial, onMute, onSettings, onEnd, onStop }: Props) {
  const shown = muted ? 'off' : state;
  const recent = messages.slice(-6);
  return <div className="live-stage">
    <VoiceOrb state={shown} level={muted ? 0 : level} />
    <p className="live-state" role="status">{liveLabel(shown, mode)}</p>
    <meter aria-label="Уровень микрофона" min={0} max={1} value={muted ? 0 : level} />
    <div className="live-log" aria-label="Текст разговора">
      {recent.length === 0 && !partial && <p className="hint">Реплики появятся здесь и останутся в этом чате.</p>}
      {recent.map(message => <article key={message.id} className={message.role}>
        <strong>{message.role === 'user' ? 'Вы' : 'Нейра'}</strong>
        {message.role === 'assistant' ? <Markdown text={message.content || '…'} /> : <p>{message.content || (message.pending ? '…' : '')}</p>}
      </article>)}
      {partial && <article className="assistant"><strong>Нейра</strong><Markdown text={partial} /></article>}
    </div>
    <div className="actions">
      <button type="button" aria-pressed={muted} disabled={busy} onClick={onMute}>{muted ? 'Включить микрофон' : 'Выключить микрофон'}</button>
      <button type="button" disabled={busy} onClick={onSettings}>Настройки голоса</button>
      {showStop && <button type="button" className="stop" onClick={onStop}>Стоп</button>}
      <button type="button" disabled={busy} onClick={onEnd}>Завершить</button>
    </div>
  </div>;
}
