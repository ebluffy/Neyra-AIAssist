import { useEffect, useRef } from 'react';
import { clock, type ChatMessage } from '../chat';
import { Markdown } from '../markdown';

interface Props {
  messages: ChatMessage[];
  partial: string;
  onCopy: (value: string) => void;
  onSpeak: (value: string) => void;
  onRepeat: (value: string) => void;
  turnBusy: boolean;
  voiceBusy: boolean;
}

export function ChatView({ messages, partial, onCopy, onSpeak, onRepeat, turnBusy, voiceBusy }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useEffect(() => {
    const node = panel.current;
    if (node && follow.current) node.scrollTop = node.scrollHeight;
  }, [messages, partial]);
  return <div className="feed" ref={panel} aria-label="История чата" onScroll={event => { const node = event.currentTarget; follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 60; }}>
    {messages.map((message, index) => {
      const previousUser = message.role === 'assistant' ? [...messages.slice(0, index)].reverse().find(item => item.role === 'user' && item.content.trim()) : undefined;
      return <article key={message.id} className={`msg ${message.role}${message.kind === 'voice' ? ' voice' : ''}`}>
        {message.role === 'user' && message.kind === 'voice' && message.audioUrl && <audio controls preload="none" src={message.audioUrl} aria-label="Голосовое сообщение" />}
        {message.role === 'user' && message.kind === 'voice' && message.durationMs !== undefined && <span className="timer">{clock(message.durationMs)}</span>}
        {message.role === 'user' && message.pending && !message.content ? <p className="hint">Распознаю речь…</p> : message.role === 'user' ? <p className="plain">{message.content}</p> : <Markdown text={message.content} onCopy={onCopy} />}
        {message.role === 'assistant' && message.content && <div className="msg-actions">
          <button type="button" onClick={() => onCopy(message.content)}>Копировать</button>
          <button type="button" disabled={voiceBusy} onClick={() => onSpeak(message.content)}>Озвучить</button>
          <button type="button" disabled={!previousUser || turnBusy} onClick={() => previousUser && onRepeat(previousUser.content)}>Повторить</button>
        </div>}
      </article>;
    })}
    {partial && <article className="msg assistant" aria-live="polite"><Markdown text={partial} /><p className="hint">Нейра печатает</p></article>}
  </div>;
}
