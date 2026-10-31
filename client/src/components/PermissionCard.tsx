import { useEffect, useRef } from 'react';
import { toolTitles, type HostCall } from '../types';

export function PermissionCard({ call, onAllow, onReject }: { call: HostCall; onAllow: () => void; onReject: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const reject = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (!node.open) node.showModal();
    reject.current?.focus();
    return () => { if (node.open) node.close(); };
  }, [call.call_id]);
  const title = call.tool === 'command.run' ? 'Запустить быструю команду?' : 'Разрешить действие на этом ПК?';
  const name = call.tool === 'command.run' ? String(call.arguments.name ?? '') : (toolTitles[call.tool] ?? call.tool);
  return <dialog ref={dialog} className="decision" aria-labelledby="confirm-title" onCancel={event => { event.preventDefault(); event.stopPropagation(); onReject(); }}>
    <h2 id="confirm-title">{title}</h2>
    <p><strong>{name}</strong></p>
    <pre>{call.preview || JSON.stringify(call.arguments, null, 2)}</pre>
    <p>Подтверждение действует только для этого вызова, до 30 секунд.</p>
    <div className="actions">
      <button type="button" ref={reject} autoFocus onClick={onReject}>Отклонить</button>
      <button type="button" className="primary" onClick={onAllow}>Разрешить один раз</button>
    </div>
  </dialog>;
}
