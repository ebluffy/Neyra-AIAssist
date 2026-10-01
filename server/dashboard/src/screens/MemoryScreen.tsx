import { useCallback, useEffect, useState } from 'react'
import { BookOpen, Brain, NotebookPen, Search, Users } from 'lucide-react'
import { apiGet, apiPost } from '../api'
import type { ApiEnvelope, MemoryPolicies, MemoryStats } from '../api'
import { Button } from '../components/ui/button'
import { EmptyState } from '../components/ui/empty-state'
import { InlineFeedback } from '../components/ui/inline-feedback'
import { PageHeader } from '../components/ui/page-header'
import { Skeleton } from '../components/ui/skeleton'

type PersonRow = { id?: string; names?: string[]; discord_ids?: string[] }
type DiaryNote = Record<string, unknown>
type JournalEntry = Record<string, unknown>

export function MemoryScreen() {
  const [tab, setTab] = useState<'overview' | 'people' | 'diary' | 'search' | 'ltm'>('overview')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [memory, setMemory] = useState<MemoryStats | null>(null)
  const [memPolicies, setMemPolicies] = useState<MemoryPolicies | null>(null)
  const [people, setPeople] = useState<PersonRow[]>([])
  const [selectedPerson, setSelectedPerson] = useState('')
  const [personDetail, setPersonDetail] = useState<Record<string, unknown> | null>(null)
  const [diary, setDiary] = useState<DiaryNote[]>([])
  const [selectedNote, setSelectedNote] = useState(0)
  const [journal, setJournal] = useState<JournalEntry[]>([])
  const [selectedJournal, setSelectedJournal] = useState(0)
  const [searchQ, setSearchQ] = useState('')
  const [searchHits, setSearchHits] = useState<unknown[] | null>(null)
  const [ltmBusy, setLtmBusy] = useState(false)
  const [ltmMsg, setLtmMsg] = useState<string | null>(null)
  const [pruneDays, setPruneDays] = useState('90')
  const [sumDays, setSumDays] = useState('60')
  const [sumCompress, setSumCompress] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [m, pol, pe, di, jo] = await Promise.all([
        apiGet<ApiEnvelope<MemoryStats>>('/v1/memory/stats'),
        apiGet<ApiEnvelope<MemoryPolicies>>('/v1/memory/policies'),
        apiGet<ApiEnvelope<{ people: PersonRow[] }>>('/v1/memory/people'),
        apiGet<ApiEnvelope<{ notes: DiaryNote[] }>>('/v1/memory/diary?limit=50'),
        apiGet<ApiEnvelope<{ entries: JournalEntry[] }>>('/v1/memory/journal?limit=50'),
      ])
      setMemory(m.data)
      setMemPolicies(pol.data)
      const plist = pe.data.people ?? []
      setPeople(plist)
      setDiary(di.data.notes ?? [])
      setJournal(jo.data.entries ?? [])
      setSelectedPerson((prev) => {
        if (prev && plist.some((p) => String(p.id) === prev)) return prev
        return plist[0]?.id ? String(plist[0].id) : ''
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!selectedPerson) {
      setPersonDetail(null)
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const r = await apiGet<ApiEnvelope<Record<string, unknown>>>(
          `/v1/memory/people/${encodeURIComponent(selectedPerson)}`,
        )
        if (!cancelled) setPersonDetail(r.data)
      } catch (e) {
        if (!cancelled) setPersonDetail({ error: e instanceof Error ? e.message : String(e) })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [selectedPerson])

  async function runSearch() {
    setError(null)
    try {
      const r = await apiPost<ApiEnvelope<{ results?: unknown[]; hits?: unknown[] }>>('/v1/memory/search', {
        query: searchQ,
        limit: 20,
      })
      setSearchHits(r.data.results ?? r.data.hits ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function runLtm(path: '/v1/memory/prune' | '/v1/memory/summarize', body: Record<string, unknown>, destructive: boolean) {
    if (destructive && !window.confirm('Это изменит долгосрочную память. Продолжить?')) return
    setLtmBusy(true)
    setLtmMsg(null)
    try {
      const r = await apiPost<ApiEnvelope<unknown>>(path, body)
      setLtmMsg(JSON.stringify(r.data, null, 2))
      await load()
    } catch (e) {
      setLtmMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setLtmBusy(false)
    }
  }

  const personLabel = (p: PersonRow) => {
    const names = (p.names ?? []).filter(Boolean)
    return names[0] || p.id || '—'
  }

  return (
    <div className="page-content stack">
      <PageHeader
        title="Память"
        subtitle="Люди, дневник, журнал и поиск по RAG"
        actions={
          <Button disabled={loading} onClick={() => void load()} type="button" variant="cyan">
            {loading ? 'Обновление…' : 'Обновить'}
          </Button>
        }
      />
      {error && <InlineFeedback tone="error">{error}</InlineFeedback>}

      <div className="tabs-row" role="tablist">
        {(
          [
            ['overview', 'Обзор', Brain],
            ['people', 'Люди', Users],
            ['diary', 'Дневник / журнал', NotebookPen],
            ['search', 'Поиск RAG', Search],
            ['ltm', 'Долгая память', BookOpen],
          ] as const
        ).map(([id, label, Icon]) => (
          <Button key={id} onClick={() => setTab(id)} size="sm" type="button" variant={tab === id ? 'default' : 'secondary'}>
            <Icon size={14} /> {label}
          </Button>
        ))}
      </div>

      {tab === 'overview' && (
        <div className="card">
          <div className="card-header">
            <Brain size={15} className="card-icon card-icon-cyan" />
            <span className="card-title">Статистика</span>
          </div>
          {loading ? (
            <div className="grid-3">
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
            </div>
          ) : (
            <div className="grid-3">
              {[
                { label: 'STM (краткая)', value: memory?.short_memory_size },
                { label: 'Chroma (RAG)', value: memory?.hub?.chroma_records ?? memory?.long_memory_records },
                { label: 'Люди', value: memory?.people_records ?? memory?.hub?.people },
                { label: 'Журнал чата', value: memory?.hub?.chat_log },
                { label: 'Дневник', value: memory?.hub?.diary_notes },
                { label: 'Режим RAG', value: memory?.hub?.rag_write_mode },
              ].map(({ label, value }) => (
                <div key={label} className="stat-tile">
                  <p className="stat-label">{label}</p>
                  <p className="stat-value-md">{value ?? '—'}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'people' && (
        <div className="split-modules">
          <div className="card" style={{ height: 'fit-content' }}>
            <div className="card-header">
              <Users size={15} className="card-icon" />
              <span className="card-title">Список ({people.length})</span>
            </div>
            <div className="stack-sm">
              {people.map((p) => (
                <button
                  key={String(p.id)}
                  className={`plugin-item${selectedPerson === String(p.id) ? ' active' : ''}`}
                  onClick={() => setSelectedPerson(String(p.id))}
                  type="button"
                >
                  <span>{personLabel(p)}</span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: '0.7rem', color: 'var(--muted)' }}>{p.id}</span>
                </button>
              ))}
              {people.length === 0 && <EmptyState icon={Users} title="Нет людей" description="Появятся после диалогов." />}
            </div>
          </div>
          <div className="card">
            <div className="card-header">
              <span className="card-title">Карточка</span>
            </div>
            {!selectedPerson ? (
              <p style={{ color: 'var(--muted)', fontSize: '0.85rem' }}>Выбери человека слева.</p>
            ) : (
              <div className="stack-sm">
                <p style={{ fontSize: '0.85rem' }}>
                  Имена:{' '}
                  <strong>{((personDetail?.person as PersonRow | undefined)?.names ?? []).join(', ') || '—'}</strong>
                </p>
                <p style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>Сводка</p>
                <pre className="code-block" style={{ maxHeight: 140, overflow: 'auto' }}>
                  {String(personDetail?.summary || '—')}
                </pre>
                <p style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>Факты</p>
                <pre className="code-block" style={{ maxHeight: 220, overflow: 'auto' }}>
                  {JSON.stringify(personDetail?.facts ?? [], null, 2)}
                </pre>
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'diary' && (
        <div className="grid-2">
          <div className="card">
            <div className="card-header">
              <NotebookPen size={15} className="card-icon" />
              <span className="card-title">Дневник ({diary.length})</span>
            </div>
            <div className="stack-sm" style={{ marginBottom: '0.75rem', maxHeight: 180, overflow: 'auto' }}>
              {diary.map((n, i) => (
                <button
                  key={i}
                  className={`plugin-item${selectedNote === i ? ' active' : ''}`}
                  onClick={() => setSelectedNote(i)}
                  type="button"
                >
                  <span style={{ fontSize: '0.8rem' }}>
                    {String(n.title || n.created_at || n.date || `Запись ${i + 1}`)}
                  </span>
                </button>
              ))}
              {diary.length === 0 && <EmptyState icon={NotebookPen} title="Пусто" description="Нет заметок дневника." />}
            </div>
            <pre className="code-block" style={{ maxHeight: 260, overflow: 'auto' }}>
              {diary[selectedNote] ? JSON.stringify(diary[selectedNote], null, 2) : '—'}
            </pre>
          </div>
          <div className="card">
            <div className="card-header">
              <span className="card-title">Журнал ядра ({journal.length})</span>
            </div>
            <div className="stack-sm" style={{ marginBottom: '0.75rem', maxHeight: 180, overflow: 'auto' }}>
              {journal.map((n, i) => (
                <button
                  key={i}
                  className={`plugin-item${selectedJournal === i ? ' active' : ''}`}
                  onClick={() => setSelectedJournal(i)}
                  type="button"
                >
                  <span style={{ fontSize: '0.8rem' }}>
                    {String(n.kind || n.type || n.created_at || `Событие ${i + 1}`)}
                  </span>
                </button>
              ))}
              {journal.length === 0 && <EmptyState icon={BookOpen} title="Пусто" description="Нет записей журнала." />}
            </div>
            <pre className="code-block" style={{ maxHeight: 260, overflow: 'auto' }}>
              {journal[selectedJournal] ? JSON.stringify(journal[selectedJournal], null, 2) : '—'}
            </pre>
          </div>
        </div>
      )}

      {tab === 'search' && (
        <div className="card">
          <div className="card-header">
            <Search size={15} className="card-icon" />
            <span className="card-title">Поиск по долгосрочной памяти (RAG)</span>
          </div>
          <p style={{ fontSize: '0.8rem', color: 'var(--muted)', marginBottom: '0.85rem', lineHeight: 1.45 }}>
            Семантический поиск по Chroma / Hub — не поиск по людям и не полнотекст дневника. Удобно проверить, что ассистент «помнит» по фразе.
          </p>
          <div className="row" style={{ alignItems: 'flex-end', marginBottom: '0.75rem' }}>
            <label className="label" style={{ flex: 1 }}>
              <span className="label-text">Запрос</span>
              <input className="input" onChange={(e) => setSearchQ(e.target.value)} value={searchQ} />
            </label>
            <Button onClick={() => void runSearch()} type="button">
              Искать
            </Button>
          </div>
          {searchHits && (
            <pre className="code-block" style={{ maxHeight: 320, overflow: 'auto' }}>
              {JSON.stringify(searchHits, null, 2)}
            </pre>
          )}
        </div>
      )}

      {tab === 'ltm' && (
        <div className="card">
          <div className="card-header">
            <Brain size={15} className="card-icon" />
            <span className="card-title">Обслуживание долгой памяти</span>
          </div>
          <div className="row" style={{ marginBottom: '0.75rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <label className="label" style={{ minWidth: 160 }}>
              <span className="label-text">Очистка: старше (дней)</span>
              <input className="input input-mono" onChange={(e) => setPruneDays(e.target.value)} style={{ width: 120 }} value={pruneDays} />
            </label>
            <label className="label" style={{ minWidth: 180 }}>
              <span className="label-text">Суммаризация: старше (дней)</span>
              <input className="input input-mono" onChange={(e) => setSumDays(e.target.value)} style={{ width: 120 }} value={sumDays} />
            </label>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.85rem', color: 'var(--muted)', marginBottom: '0.85rem', cursor: 'pointer' }}>
            <input checked={sumCompress} onChange={(e) => setSumCompress(e.target.checked)} type="checkbox" />
            Суммаризация со сжатием через LLM
          </label>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <Button
              disabled={ltmBusy}
              onClick={() => void runLtm('/v1/memory/prune', { older_than_days: Number(pruneDays) || 90, dry_run: true }, false)}
              type="button"
              variant="secondary"
            >
              Очистка (пробный запуск)
            </Button>
            <Button
              disabled={ltmBusy}
              onClick={() => void runLtm('/v1/memory/prune', { older_than_days: Number(pruneDays) || 90, dry_run: false }, true)}
              type="button"
              variant="warn"
            >
              Очистка
            </Button>
            <Button
              disabled={ltmBusy}
              onClick={() =>
                void runLtm(
                  '/v1/memory/summarize',
                  { older_than_days: Number(sumDays) || 60, dry_run: true, max_entries: 500, compress_with_llm: sumCompress },
                  false,
                )
              }
              type="button"
              variant="secondary"
            >
              Суммаризация (пробный запуск)
            </Button>
            <Button
              disabled={ltmBusy}
              onClick={() =>
                void runLtm(
                  '/v1/memory/summarize',
                  { older_than_days: Number(sumDays) || 60, dry_run: false, max_entries: 500, compress_with_llm: sumCompress },
                  true,
                )
              }
              type="button"
              variant="cyan"
            >
              Суммаризация
            </Button>
          </div>
          {ltmMsg && (
            <pre className="code-block" style={{ marginTop: '0.85rem', maxHeight: 200, overflow: 'auto' }}>
              {ltmMsg}
            </pre>
          )}
          {memPolicies && (
            <pre className="code-block" style={{ marginTop: '0.85rem', maxHeight: 160, overflow: 'auto' }}>
              {JSON.stringify(
                {
                  archive: memPolicies.ltm_archive_dir,
                  embedding: memPolicies.embedding_model,
                  auto_prune: memPolicies.ltm_auto_prune,
                  auto_summarize: memPolicies.ltm_auto_summarize,
                },
                null,
                2,
              )}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
