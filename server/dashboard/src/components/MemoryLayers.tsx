import { useCallback, useEffect, useState } from 'react'
import { BookOpen, ScrollText } from 'lucide-react'
import { apiDelete, apiGet } from '../api'
import type { ApiEnvelope } from '../api'
import { Button } from './ui/button'
import { DangerConfirmDialog } from './ui/danger-confirm-dialog'
import { EmptyState } from './ui/empty-state'
import { InlineFeedback } from './ui/inline-feedback'
import { Skeleton } from './ui/skeleton'

type Entry = { id?: number; title?: string; kind?: string; ts?: string; created_at?: string; text?: string; fact?: string; person_id?: string; source?: string }
type Window = { owner_id: string | null; channel_id: string | null; messages: { role: string; content: string }[] }

function useMemoryData<T>(path: string) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try { setData((await apiGet<ApiEnvelope<T>>(path)).data) }
    catch (e) { setError(e instanceof Error ? e.message : 'Не удалось загрузить память') }
    finally { setLoading(false) }
  }, [path])
  useEffect(() => { void load() }, [load])
  return { data, error, loading, load }
}

export function ShortMemoryPanel() {
  const { data, error, loading, load } = useMemoryData<{ windows: Window[]; max_messages_per_window: number }>('/v1/memory/short')
  return <section className="card stack" aria-label="Короткая память">
    <div className="card-header" style={{ flexWrap: 'wrap' }}><h2 className="card-title">Контекст чата</h2><Button disabled={loading} onClick={() => void load()}>Обновить контекст</Button></div>
    <p className="muted">История по собеседнику и каналу в текущем процессе. До {data?.max_messages_per_window ?? '…'} сообщений на окно; просмотр ограничен последними 20. Это история для модели, без скрытых рассуждений и извлечённых воспоминаний. После рестарта окно начинается заново.</p>
    {error && <InlineFeedback tone="error">{error}</InlineFeedback>}
    {loading && <Skeleton className="h-20" />}
    {!loading && data?.windows.length === 0 && <EmptyState icon={ScrollText} title="Контекст пока пуст" description="Окна появятся после диалога с Нейрой." />}
    {data?.windows.map((window, i) => <details key={`${window.owner_id}:${window.channel_id}:${i}`} className="card break-words">
      <summary className="cursor-pointer rounded-md p-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">Собеседник {window.owner_id ?? 'не указан'} · канал {window.channel_id ?? 'не указан'} · {window.messages.length} сообщений</summary>
      <div className="stack-sm">{window.messages.map((message, j) => <div key={j}><p className="muted">{message.role === 'assistant' ? 'Нейра' : 'Собеседник'}</p><pre className="code-block" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{message.content}</pre></div>)}</div>
    </details>)}
  </section>
}

export function LongMemoryPanel() {
  const { data, error, loading, load } = useMemoryData<{ entries: Entry[] }>('/v1/memory/long')
  return <section className="card stack" aria-label="Долгая память">
    <div className="card-header" style={{ flexWrap: 'wrap' }}><h2 className="card-title">Сохранённые сведения</h2><Button disabled={loading} onClick={() => void load()}>Обновить сведения</Button></div>
    <p className="muted">Факты из профилей, в том числе сохранённые после рефлексии. Источник указан у записи. Исправление и удаление фактов доступны во вкладке «Люди». Нейра автоматически подбирает воспоминания для ответа.</p>
    {error && <InlineFeedback tone="error">{error}</InlineFeedback>}
    {loading && <Skeleton className="h-20" />}
    {!loading && data?.entries.length === 0 && <EmptyState icon={BookOpen} title="Нет сохранённых сведений" description="Здесь появятся факты, сохранённые в профилях людей." />}
    {data?.entries.map((entry, i) => <article key={`${entry.person_id}:${entry.id ?? i}`} className="card">
      <p style={{ overflowWrap: 'anywhere' }}>{entry.fact ?? entry.text}</p>
      <p className="muted" style={{ overflowWrap: 'anywhere' }}>Профиль: {entry.person_id} · источник: {entry.source ?? 'не указан'} · {entry.ts ?? entry.created_at ?? 'дата не указана'}</p>
    </article>)}
    {Boolean(data?.entries.length) && <p className="muted">Показано до 200 фактов, до 20 на профиль. Это не полный экспорт памяти.</p>}
  </section>
}

export function CoreJournalPanel() {
  const { data, error, loading, load } = useMemoryData<{ entries: Entry[] }>('/v1/memory/journal?limit=50')
  const [danger, setDanger] = useState<number | 'clear' | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')
  async function remove() {
    setBusy(true)
    setActionError('')
    try {
      await apiDelete(danger === 'clear' ? '/v1/memory/journal?confirm=WIPE' : `/v1/memory/journal/${danger}`)
      setDanger(null)
      await load()
    } catch (e) { setActionError(e instanceof Error ? e.message : 'Не удалось удалить запись') }
    finally { setBusy(false) }
  }
  return <section className="card stack" aria-label="Журнал ядра">
    <div className="card-header" style={{ flexWrap: 'wrap' }}><h2 className="card-title">Журнал ядра</h2><Button disabled={loading} onClick={() => void load()}>Обновить журнал</Button><Button variant="warn" disabled={busy} onClick={() => setDanger('clear')}>Очистить журнал</Button></div>
    <p className="muted">Технические итоги рефлексии и обработки памяти. Записи создаёт ядро; ручного добавления нет. Администратор может удалить запись или очистить журнал с резервной копией.</p>
    {(error || actionError) && <InlineFeedback tone="error">{actionError || error}</InlineFeedback>}
    {loading && <Skeleton className="h-20" />}
    {!loading && data?.entries.length === 0 && <EmptyState icon={ScrollText} title="Журнал пуст" description="События появятся после рефлексии." />}
    {data?.entries.map((entry) => <article className="card stack-sm" key={entry.id}>
      <div className="row" style={{ flexWrap: 'wrap' }}><h3>{entry.title || entry.kind || entry.ts || `Событие ${entry.id}`}</h3><Button aria-label={`Удалить запись журнала ${entry.id}`} variant="secondary" onClick={() => setDanger(entry.id ?? null)}>Удалить</Button></div>
      <pre className="code-block" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{entry.text}</pre>
    </article>)}
    <DangerConfirmDialog open={danger !== null} title={danger === 'clear' ? 'Очистить журнал ядра?' : 'Удалить запись журнала?'} description={actionError || 'Действие доступно администратору и применяется глобально. Отменить удаление нельзя.'} confirmPhrase={danger === 'clear' ? 'WIPE' : 'УДАЛИТЬ'} confirmLabel="Удалить" busy={busy} onCancel={() => setDanger(null)} onConfirm={() => void remove()} />
  </section>
}
