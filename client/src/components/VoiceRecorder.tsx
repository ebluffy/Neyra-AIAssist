import { useEffect, useState } from 'react';
import { ArrowUp, Trash2 } from 'lucide-react';
import { clock } from '../chat';

export function VoiceRecorder({ level, busy, onCancel, onDone }: { level: number; busy: boolean; onCancel: () => void; onDone: () => void }) {
  const [phase, setPhase] = useState(0);
  const [ms, setMs] = useState(0);
  useEffect(() => {
    const start = performance.now();
    const timer = window.setInterval(() => setMs(performance.now() - start), 200);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let frame = 0;
    const tick = () => { setPhase(value => value + 0.28); frame = window.requestAnimationFrame(tick); };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, []);
  return <div className="recorder" role="group" aria-label="Запись голосового">
    <div className="wave" aria-hidden="true">{Array.from({ length: 48 }, (_, index) => {
      const shape = 0.28 + 0.72 * Math.abs(Math.sin(index * 0.45 + phase));
      return <span key={index} style={{ height: `${4 + Math.min(1, level) * shape * 24}px` }} />;
    })}</div>
    <span className="timer" role="timer" aria-label="Длительность записи">{clock(ms)}</span>
    <button type="button" className="icon danger" aria-label="Отмена" data-tip="Отмена" disabled={busy} onClick={onCancel}><Trash2 size={18} strokeWidth={1.75} aria-hidden="true" /></button>
    <button type="button" className="icon primary" aria-label="Отправить" data-tip="Отправить" disabled={busy} onClick={onDone}><ArrowUp size={18} strokeWidth={2} aria-hidden="true" /></button>
  </div>;
}
