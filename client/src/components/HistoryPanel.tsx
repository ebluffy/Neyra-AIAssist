import { X } from 'lucide-react';
import type { ChatThread } from '../chat';

export function HistoryPanel({ open, threads, activeId, onClose, onOpen, onNew, disabled = false }: { open: boolean; threads: ChatThread[]; activeId: string; onClose: () => void; onOpen: (id: string) => void; onNew: () => void; disabled?: boolean }) {
  const ordered = [...threads].sort((a, b) => b.updated - a.updated);
  return <aside className={open ? 'history open' : 'history'} aria-label="История чатов" inert={!open}>
    <div className="history-inner">
      <div className="history-bar">
        <strong>Чаты</strong>
        <button type="button" className="icon" aria-label="Закрыть историю" onClick={onClose}><X size={18} strokeWidth={1.75} aria-hidden="true" /></button>
      </div>
      <button type="button" className="primary" disabled={disabled} onClick={onNew}>Новый чат</button>
      {ordered.length === 0 && <p className="hint">Пока нет сохранённых чатов.</p>}
      <ul>{ordered.map(thread => <li key={thread.id}><button type="button" disabled={disabled} aria-current={thread.id === activeId ? 'true' : undefined} onClick={() => onOpen(thread.id)}><span>{thread.title}</span><time dateTime={new Date(thread.updated).toISOString()}>{new Date(thread.updated).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</time></button></li>)}</ul>
    </div>
  </aside>;
}
