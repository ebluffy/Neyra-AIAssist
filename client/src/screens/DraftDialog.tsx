import { useEffect, useRef } from 'react';
import { type DraftEvent, summarizeActions, summarizeTriggers } from '../commands';

interface Props { draft?: DraftEvent; busy: boolean; onSave: (draft: DraftEvent) => void; onReject: (draft: DraftEvent) => void }

export function DraftDialog({ draft, busy, onSave, onReject }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (draft) dialog.current?.showModal(); else dialog.current?.close(); }, [draft]);
  return <dialog ref={dialog} aria-labelledby="draft-title" onCancel={e => { e.preventDefault(); if (draft) onReject(draft); }}>
    <h2 id="draft-title">Сохранить команду на этом ПК?</h2>
    {draft && <>
      <p>Нейра предлагает быструю команду. Она сохранится только здесь, после вашего подтверждения.</p>
      <p><strong>{draft.command.name}</strong></p>
      <p>{summarizeTriggers(draft.command)}</p>
      <p>{summarizeActions(draft.command)}</p>
      <pre>{JSON.stringify(draft.command.actions, null, 2)}</pre>
      {draft.exists && <p className="error" role="alert">Команда с таким именем уже есть. Переименуйте или удалите её, затем попросите Нейру снова.</p>}
      <div className="actions">
        <button autoFocus onClick={() => onReject(draft)}>Отклонить</button>
        <button className="primary" disabled={busy || draft.exists} onClick={() => onSave(draft)}>Сохранить</button>
      </div>
    </>}
  </dialog>;
}
