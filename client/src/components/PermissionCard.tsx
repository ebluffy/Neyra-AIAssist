import { useEffect, useRef } from 'react';
import { toolTitles, type HostCall } from '../types';

export function PermissionCard({ call, onAllow, onReject }: { call: HostCall; onAllow: () => void; onReject: () => void }) {
  const reject = useRef<HTMLButtonElement>(null);
  useEffect(() => { reject.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); onReject(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onReject]);
  const title = call.tool === 'command.run' ? 'Запустить быструю команду?' : 'Разрешить действие на этом ПК?';
  const name = call.tool === 'command.run' ? String(call.arguments.name ?? '') : (toolTitles[call.tool] ?? call.tool);
  return <article className="decision" role="dialog" aria-labelledby="confirm-title">
    <h2 id="confirm-title">{title}</h2>
    <p><strong>{name}</strong></p>
    <pre>{call.preview || JSON.stringify(call.arguments, null, 2)}</pre>
    <p>Подтверждение действует только для этого вызова, до 30 секунд.</p>
    <div className="actions">
      <button type="button" ref={reject} autoFocus onClick={onReject}>Отклонить</button>
      <button type="button" className="primary" onClick={onAllow}>Разрешить один раз</button>
    </div>
  </article>;
}
