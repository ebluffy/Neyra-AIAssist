import { useEffect, useRef } from 'react';
import { type DraftEvent, summarizeActions, summarizeTriggers } from '../commands';

interface Props { draft: DraftEvent; busy: boolean; onSave: (draft: DraftEvent) => void; onReject: (draft: DraftEvent) => void }

export function DraftDialog({ draft, busy, onSave, onReject }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const reject = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (!node.open) node.showModal();
    reject.current?.focus();
    return () => { if (node.open) node.close(); };
  }, [draft.draft_id]);
  return <dialog ref={dialog} className="decision" aria-labelledby="draft-title" onCancel={event => { event.preventDefault(); event.stopPropagation(); onReject(draft); }}>
    <h2 id="draft-title">Сохранить команду на этом ПК?</h2>
    <p>Нейра предлагает быструю команду. Она сохранится только здесь, после вашего подтверждения.</p>
    <p><strong>{draft.command.name}</strong></p>
    <p>{summarizeTriggers(draft.command)}</p>
    <p>{summarizeActions(draft.command)}</p>
    <pre>{JSON.stringify(draft.command.actions, null, 2)}</pre>
    {draft.exists && <p className="error" role="alert">Команда с таким именем уже есть. Переименуйте или удалите её, затем попросите Нейру снова.</p>}
    <div className="actions">
      <button type="button" ref={reject} autoFocus onClick={() => onReject(draft)}>Отклонить</button>
      <button type="button" className="primary" disabled={busy || draft.exists} onClick={() => onSave(draft)}>Сохранить</button>
    </div>
  </dialog>;
}
