import { useEffect, useRef, useState } from 'react';
import { Copy, RotateCcw, Volume2 } from 'lucide-react';
import { clock, type ChatMessage } from '../chat';
import { Markdown } from '../markdown';
import { VoiceOrb } from './VoiceOrb';

interface Props {
  messages: ChatMessage[];
  partial: string;
  thinking: boolean;
  onCopy: (value: string) => void;
  onSpeak: (value: string) => void;
  onRepeat: (value: string) => void;
  turnBusy: boolean;
  voiceBusy: boolean;
}

function StreamingBody({ text }: { text: string }) {
  const [settled, setSettled] = useState('');
  const prefix = text.startsWith(settled);
  const head = prefix ? settled : text;
  const added = prefix ? text.slice(settled.length) : '';
  useEffect(() => {
    const delay = window.matchMedia('(prefers-reduced-motion: reduce)').matches || !text.startsWith(settled) ? 0 : 160;
    if (settled === text) return;
    const timer = window.setTimeout(() => setSettled(text), delay);
    return () => window.clearTimeout(timer);
  }, [text, settled]);
  const plain = added.length > 0 && !/[`*#|[\]>]/.test(added);
  if (!plain) return <Markdown text={text} />;
  return <>{head && <Markdown text={head} />}<span className="arriving">{added}</span></>;
}

export function ChatView({ messages, partial, thinking, onCopy, onSpeak, onRepeat, turnBusy, voiceBusy }: Props) {
  const lastAssistant = [...messages].reverse().find(item => item.role === 'assistant' && item.content)?.id;
  const panel = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useEffect(() => {
    const box = panel.current;
    if (box && follow.current) box.scrollTop = box.scrollHeight;
  }, [messages, partial, thinking]);
  return <div className="feed" ref={panel} aria-label="История чата" onScroll={event => { const box = event.currentTarget; follow.current = box.scrollHeight - box.scrollTop - box.clientHeight < 60; }}>
    {messages.map((message, index) => {
      const previousUser = message.role === 'assistant' ? [...messages.slice(0, index)].reverse().find(item => item.role === 'user' && item.content.trim()) : undefined;
      const continued = index > 0 && messages[index - 1].role === message.role;
      return <article key={message.id} className={`msg ${message.role}${message.kind === 'voice' ? ' voice' : ''}${continued ? ' cont' : ''}${message.id === lastAssistant ? ' is-last' : ''}`}>
        {message.role === 'assistant' && <span className="avatar">{!continued && <VoiceOrb state="idle" level={0} pip />}</span>}
        <div className="msg-body">
          {message.role === 'user' && message.kind === 'voice' && message.audioUrl && <audio controls preload="none" src={message.audioUrl} aria-label="Голосовое сообщение" />}
          {message.role === 'user' && message.kind === 'voice' && message.durationMs !== undefined && <span className="timer">{clock(message.durationMs)}</span>}
          {message.role === 'user' && message.pending && !message.content ? <p className="hint">Распознаю речь…</p> : message.role === 'user' ? <p className="plain">{message.content}</p> : <Markdown text={message.content} onCopy={onCopy} />}
          {message.role === 'assistant' && message.content && <div className="msg-actions">
            <button type="button" aria-label="Копировать" data-tip="Копировать" onClick={() => onCopy(message.content)}><Copy size={16} strokeWidth={1.75} aria-hidden="true" /></button>
            <button type="button" aria-label="Озвучить" data-tip="Озвучить" disabled={voiceBusy} onClick={() => onSpeak(message.content)}><Volume2 size={16} strokeWidth={1.75} aria-hidden="true" /></button>
            <button type="button" aria-label="Повторить" data-tip="Повторить" disabled={!previousUser || turnBusy} onClick={() => previousUser && onRepeat(previousUser.content)}><RotateCcw size={16} strokeWidth={1.75} aria-hidden="true" /></button>
          </div>}
        </div>
      </article>;
    })}
    {thinking && !partial && <article className="msg assistant is-streaming" aria-live="polite">
      <span className="avatar"><VoiceOrb state="thinking" level={0} pip /></span>
      <div className="msg-body"><p className="hint">Нейра думает</p></div>
    </article>}
    {partial && <article className={`msg assistant is-streaming${messages.at(-1)?.role === 'assistant' ? ' cont' : ''}`} aria-live="polite">
      <span className="avatar">{messages.at(-1)?.role !== 'assistant' && <VoiceOrb state="thinking" level={0.35} pip />}</span>
      <div className="msg-body">
        <StreamingBody text={partial} />
        <p className="hint">Нейра печатает</p>
      </div>
    </article>}
  </div>;
}
