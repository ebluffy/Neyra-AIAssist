import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { historyGroups, type ChatThread } from '../chat';

const historyDate = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function HistoryPanel({ open, threads, activeId, onClose, onOpen, onNew, disabled = false }: { open: boolean; threads: ChatThread[]; activeId: string; onClose: () => void; onOpen: (id: string) => void; onNew: () => void; disabled?: boolean }) {
  const [, setDay] = useState(() => new Date().toDateString());
  useEffect(() => {
    if (!open) return;
    const sync = () => setDay(new Date().toDateString());
    const next = new Date(); next.setHours(24, 0, 1, 0);
    const timer = window.setTimeout(sync, next.getTime() - Date.now());
    window.addEventListener('focus', sync);
    document.addEventListener('visibilitychange', sync);
    return () => { window.clearTimeout(timer); window.removeEventListener('focus', sync); document.removeEventListener('visibilitychange', sync); };
  });
  const groups = historyGroups(threads);
  return <aside className={open ? 'history open' : 'history'} aria-label="История чатов" inert={!open}>
    <div className="history-inner">
      <div className="history-bar">
        <h2>Чаты</h2>
        <button type="button" className="icon" aria-label="Закрыть историю" onClick={onClose}><X size={18} strokeWidth={1.75} aria-hidden="true" /></button>
      </div>
      <button type="button" className="primary" disabled={disabled} onClick={onNew}>Новый чат</button>
      {groups.length === 0 && <p className="hint">Пока нет сохранённых чатов.</p>}
      <div className="history-list">{groups.map(group => <section className="history-group" key={group.label}>
        <h3>{group.label}</h3>
        <ul>{group.threads.map(thread => {
          const title = thread.title.trim() || 'Новый чат';
          return <li key={thread.id}><button type="button" disabled={disabled} aria-current={thread.id === activeId ? 'true' : undefined} onClick={() => onOpen(thread.id)}><span className="history-title" title={title}>{title}</span><time dateTime={new Date(thread.updated).toISOString()}>{historyDate.format(thread.updated)}</time></button></li>;
        })}</ul>
      </section>)}</div>
    </div>
  </aside>;
}
