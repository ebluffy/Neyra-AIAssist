import { useEffect, useRef } from 'react';
import { type DraftEvent, summarizeActions, summarizeTriggers } from '../commands';

interface Props { draft?: DraftEvent; busy: boolean; onSave: (draft: DraftEvent) => void; onReject: (draft: DraftEvent) => void }

export function DraftDialog({ draft, busy, onSave, onReject }: Props) {
  const reject = useRef<HTMLButtonElement>(null);
  const rejectRef = useRef(onReject);
  useEffect(() => { rejectRef.current = onReject; });
  useEffect(() => { if (draft) reject.current?.focus(); }, [draft]);
  useEffect(() => {
    if (!draft) return;
    const current = draft;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); rejectRef.current(current); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [draft]);
  if (!draft) return null;
  return <article className="decision" role="dialog" aria-labelledby="draft-title">
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
  </article>;
}
