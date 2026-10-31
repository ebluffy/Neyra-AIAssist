import type { ChatThread } from '../chat';
import { CloseIcon } from '../icons';

export function HistoryPanel({ open, threads, activeId, onClose, onOpen, onNew }: { open: boolean; threads: ChatThread[]; activeId: string; onClose: () => void; onOpen: (id: string) => void; onNew: () => void }) {
  const ordered = [...threads].sort((a, b) => b.updated - a.updated);
  return <aside className={open ? 'history open' : 'history'} aria-label="История чатов" inert={!open}>
    <div className="history-inner">
      <div className="history-bar">
        <strong>Чаты</strong>
        <button type="button" className="icon" aria-label="Закрыть историю" onClick={onClose}><CloseIcon /></button>
      </div>
      <button type="button" className="primary" onClick={onNew}>Новый чат</button>
      {ordered.length === 0 && <p className="hint">Пока нет сохранённых чатов.</p>}
      <ul>{ordered.map(thread => <li key={thread.id}><button type="button" aria-current={thread.id === activeId ? 'true' : undefined} onClick={() => onOpen(thread.id)}><span>{thread.title}</span><time dateTime={new Date(thread.updated).toISOString()}>{new Date(thread.updated).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</time></button></li>)}</ul>
    </div>
  </aside>;
}
