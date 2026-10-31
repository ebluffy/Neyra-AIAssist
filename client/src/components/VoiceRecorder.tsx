import { useEffect, useState } from 'react';
import { clock } from '../chat';

export function VoiceRecorder({ busy, onCancel, onDone }: { busy: boolean; onCancel: () => void; onDone: () => void }) {
  const [ms, setMs] = useState(0);
  useEffect(() => {
    const start = performance.now();
    const timer = window.setInterval(() => setMs(performance.now() - start), 200);
    return () => window.clearInterval(timer);
  }, []);
  return <div className="recorder" role="group" aria-label="Запись голосового">
    <div className="wave" aria-hidden="true">{Array.from({ length: 17 }, (_, index) => <span key={index} style={{ animationDelay: `${index * 45}ms` }} />)}</div>
    <span className="timer" role="timer" aria-label="Длительность записи">{clock(ms)}</span>
    <button type="button" disabled={busy} onClick={onCancel}>Отмена</button>
    <button type="button" className="primary" disabled={busy} onClick={onDone}>Готово</button>
  </div>;
}
