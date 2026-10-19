import { GitMerge } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Button } from './ui/button'
import { EmptyState } from './ui/empty-state'

export type MergeProposal = { id?: number; person_a?: string; person_b?: string; reason?: string; status?: string }
export type MergeHistory = { id?: number; survivor_id?: string; source_id?: string; source_label?: string; survivor_label?: string; created_at?: string; undone_at?: string | null; reason?: string }
type Person = { id?: string; names?: string[]; display_name?: string }

export function PeopleMerges({ proposals, history, people, busy, onApply, onReject, onUndo, onRefresh }: {
  proposals: MergeProposal[]; history: MergeHistory[]; people: Person[]; busy: boolean
  onApply: (id: number) => void; onReject: (id: number) => Promise<void>; onUndo: (id: number) => void; onRefresh: () => void
}) {
  const [mode, setMode] = useState('pending')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const [rejecting, setRejecting] = useState<number | null>(null)
  const label = (id?: string, fallback?: string) => {
    const person = people.find((p) => p.id === id)
    return person?.display_name || person?.names?.[0] || fallback || id || 'Неизвестная карточка'
  }
  const rows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('ru')
    return (mode === 'pending' ? proposals : history).filter((row) => row.id != null && (!needle || JSON.stringify(row).toLocaleLowerCase('ru').includes(needle)
      || people.some((p) => ('person_a' in row ? [row.person_a, row.person_b] : [(row as MergeHistory).source_id, (row as MergeHistory).survivor_id]).includes(p.id)
        && [p.display_name, ...(p.names || [])].some((name) => name?.toLocaleLowerCase('ru').includes(needle)))))
  }, [mode, query, proposals, history, people])
  const pages = Math.max(1, Math.ceil(rows.length / 10))
  const current = Math.min(page, pages - 1)
  return (
    <section className="card min-w-0" aria-label="Объединения карточек">
      <div className="card-header flex-wrap gap-3"><h2 className="card-title">Объединения карточек</h2><Button type="button" variant="secondary" onClick={onRefresh} disabled={busy}>Обновить список</Button></div>
      <p className="hint">Совпадение имени не доказывает, что это один человек. Объединение и его отмена требуют подтверждения.</p>
      <div className="grid-2 min-w-0">
        <label className="label">Список объединений
          <select className="select" value={mode} onChange={(e) => { setMode(e.target.value); setPage(0); setQuery('') }}>
            <option value="pending">Предложения ({proposals.length})</option><option value="history">История ({history.length})</option>
          </select>
        </label>
        <label className="label">Поиск объединений<input className="input" value={query} onChange={(e) => { setQuery(e.target.value); setPage(0) }} placeholder="Имя, ID или причина" /></label>
      </div>
      <p className="hint" role="status" aria-live="polite">Найдено: {rows.length}. {mode === 'history' && 'Показаны последние 50 операций, включая отменённые.'}</p>
      {!rows.length ? <EmptyState icon={GitMerge} title={query ? 'Совпадений нет' : mode === 'pending' ? 'Нет предложений объединения' : 'История объединений пуста'} description={query ? 'Измените поисковый запрос.' : 'Записи появятся после предложения или объединения карточек.'} /> : (
        <ol className="stack-sm m-0 list-none p-0" aria-label={mode === 'pending' ? 'Предложения объединения' : 'История объединений'}>
          {rows.slice(current * 10, current * 10 + 10).map((item) => {
            const proposal = item as MergeProposal
            const merge = item as MergeHistory
            const target = mode === 'pending' ? proposal.person_a : merge.survivor_id
            const source = mode === 'pending' ? proposal.person_b : merge.source_id
            return <li key={`${mode}-${item.id}`} className="rounded-lg border border-[var(--border)] p-4 min-w-0">
              <div className="row-between flex-wrap gap-3"><h3 className="text-sm font-semibold break-words">{label(source, merge.source_label)} → {label(target, merge.survivor_label)}</h3><span className="hint">#{item.id} · {mode === 'pending' ? 'Ожидает решения' : merge.undone_at ? 'Отменено' : 'Объединено'}</span></div>
              {mode === 'pending' && <p className="hint">Сохранится карточка «{label(target)}»; факты и аккаунты будут перенесены из «{label(source)}».</p>}
              {item.reason && <p className="hint break-words">Причина: {item.reason}</p>}
              {merge.created_at && <p className="hint">Создано: <time dateTime={merge.created_at}>{new Date(merge.created_at).toLocaleString('ru-RU')}</time></p>}
              {merge.undone_at && <p className="hint">Отменено: <time dateTime={merge.undone_at}>{new Date(merge.undone_at).toLocaleString('ru-RU')}</time></p>}
              <details className="mb-3"><summary className="hint cursor-pointer py-2">Идентификаторы карточек</summary><p className="hint break-all">Источник: {source}<br />Получатель: {target}</p></details>
              <div className="row flex-wrap">
                {mode === 'pending' ? <><Button type="button" disabled={busy || rejecting !== null} onClick={() => onApply(Number(item.id))}>Объединить карточки</Button><Button type="button" variant="secondary" disabled={busy || rejecting !== null} onClick={async () => { setRejecting(Number(item.id)); try { await onReject(Number(item.id)) } finally { setRejecting(null) } }}>{rejecting === item.id ? 'Отклонение…' : 'Отклонить предложение'}</Button></> : !merge.undone_at && <Button type="button" variant="warn" disabled={busy} onClick={() => onUndo(Number(item.id))} aria-label={`Отменить объединение #${item.id}`}>Отменить объединение</Button>}
              </div>
            </li>
          })}
        </ol>
      )}
      {pages > 1 && <nav aria-label="Страницы объединений" className="row flex-wrap mt-3"><Button variant="secondary" type="button" disabled={current === 0} onClick={() => setPage(current - 1)}>Назад</Button><span className="hint">Страница {current + 1} из {pages}</span><Button variant="secondary" type="button" disabled={current + 1 >= pages} onClick={() => setPage(current + 1)}>Далее</Button></nav>}
    </section>
  )
}
