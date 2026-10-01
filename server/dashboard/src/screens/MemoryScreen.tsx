import { useCallback, useEffect, useMemo, useState } from 'react'
import { BookOpen, Brain, NotebookPen, Plus, Search, Trash2, Users } from 'lucide-react'
import { apiDelete, apiGet, apiPatch, apiPost } from '../api'
import type { ApiEnvelope, MemoryPolicies, MemoryStats } from '../api'
import { Button } from '../components/ui/button'
import { EmptyState } from '../components/ui/empty-state'
import { InlineFeedback } from '../components/ui/inline-feedback'
import { PageHeader } from '../components/ui/page-header'
import { Skeleton } from '../components/ui/skeleton'

type Profile = {
  first_name?: string
  last_name?: string
  birth_date?: string
  city?: string
  occupation?: string
  relation?: string
}

type PersonRow = {
  id?: string
  names?: string[]
  discord_ids?: string[]
  profile?: Profile
}

type PersonFact = { id?: number; fact?: string; created_at?: string; emotion_note?: string }
type DiaryNote = Record<string, unknown>
type JournalEntry = Record<string, unknown>

const PROFILE_FIELDS: Array<{ key: keyof Profile; label: string; placeholder: string }> = [
  { key: 'first_name', label: 'Имя', placeholder: 'Имя' },
  { key: 'last_name', label: 'Фамилия', placeholder: 'Фамилия' },
  { key: 'birth_date', label: 'Дата рождения', placeholder: '2004 / 12.03.2004' },
  { key: 'city', label: 'Город', placeholder: 'Город' },
  { key: 'occupation', label: 'Занятие', placeholder: 'Учёба / работа' },
  { key: 'relation', label: 'Связь', placeholder: 'друг, одноклассник…' },
]

const emptyProfile = (): Profile => ({
  first_name: '',
  last_name: '',
  birth_date: '',
  city: '',
  occupation: '',
  relation: '',
})

export function MemoryScreen() {
  const [tab, setTab] = useState<'overview' | 'people' | 'diary' | 'search' | 'ltm'>('overview')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const [memory, setMemory] = useState<MemoryStats | null>(null)
  const [memPolicies, setMemPolicies] = useState<MemoryPolicies | null>(null)
  const [people, setPeople] = useState<PersonRow[]>([])
  const [selectedPerson, setSelectedPerson] = useState('')
  const [profile, setProfile] = useState<Profile>(emptyProfile())
  const [aliases, setAliases] = useState('')
  const [discordIds, setDiscordIds] = useState('')
  const [facts, setFacts] = useState<PersonFact[]>([])
  const [legacyHints, setLegacyHints] = useState<string[]>([])
  const [newFact, setNewFact] = useState('')
  const [creating, setCreating] = useState(false)
  const [newPersonId, setNewPersonId] = useState('')
  const [diary, setDiary] = useState<DiaryNote[]>([])
  const [selectedNote, setSelectedNote] = useState(0)
  const [journal, setJournal] = useState<JournalEntry[]>([])
  const [selectedJournal, setSelectedJournal] = useState(0)
  const [diaryDraft, setDiaryDraft] = useState('')
  const [journalDraft, setJournalDraft] = useState('')
  const [journalTitle, setJournalTitle] = useState('')
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

  const loadPerson = useCallback(async (pid: string) => {
    if (!pid) {
      setProfile(emptyProfile())
      setAliases('')
      setDiscordIds('')
      setFacts([])
      setLegacyHints([])
      return
    }
    try {
      const r = await apiGet<
        ApiEnvelope<{
          person?: PersonRow | null
          profile?: Profile
          facts?: PersonFact[]
          legacy_fact_hints?: string[]
        }>
      >(`/v1/memory/people/${encodeURIComponent(pid)}`)
      const person = r.data.person
      const pr = { ...emptyProfile(), ...(r.data.profile || person?.profile || {}) }
      setProfile(pr)
      setAliases((person?.names ?? []).join(', '))
      setDiscordIds((person?.discord_ids ?? []).join(', '))
      setFacts(r.data.facts ?? [])
      setLegacyHints(r.data.legacy_fact_hints ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void loadPerson(selectedPerson)
  }, [selectedPerson, loadPerson])

  const personLabel = (p: PersonRow) => {
    const pr = p.profile || {}
    const full = [pr.first_name, pr.last_name].filter(Boolean).join(' ')
    if (full) return full
    const names = (p.names ?? []).filter(Boolean)
    return names[0] || p.id || '—'
  }

  async function savePerson() {
    if (!selectedPerson) return
    setStatus('')
    setError(null)
    try {
      await apiPatch(`/v1/memory/people/${encodeURIComponent(selectedPerson)}`, {
        names: aliases.split(',').map((s) => s.trim()).filter(Boolean),
        discord_ids: discordIds.split(',').map((s) => s.trim()).filter(Boolean),
        profile,
      })
      setStatus('Карточка сохранена')
      await load()
      await loadPerson(selectedPerson)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function createPerson() {
    setError(null)
    setStatus('')
    try {
      const r = await apiPost<ApiEnvelope<{ person?: PersonRow }>>('/v1/memory/people', {
        id: newPersonId.trim() || undefined,
        names: aliases.split(',').map((s) => s.trim()).filter(Boolean),
        discord_ids: discordIds.split(',').map((s) => s.trim()).filter(Boolean),
        profile,
      })
      const id = String(r.data.person?.id || newPersonId || '')
      setCreating(false)
      setNewPersonId('')
      setStatus('Человек создан')
      await load()
      if (id) setSelectedPerson(id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function deletePerson() {
    if (!selectedPerson) return
    if (!window.confirm(`Удалить досье «${selectedPerson}» и все факты?`)) return
    try {
      await apiDelete(`/v1/memory/people/${encodeURIComponent(selectedPerson)}`)
      setSelectedPerson('')
      setStatus('Удалено')
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function addFact() {
    if (!selectedPerson || !newFact.trim()) return
    try {
      await apiPost(`/v1/memory/people/${encodeURIComponent(selectedPerson)}/facts`, {
        fact: newFact.trim(),
      })
      setNewFact('')
      setStatus('Факт добавлен')
      await loadPerson(selectedPerson)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function removeFact(factId: number) {
    if (!selectedPerson) return
    try {
      await apiDelete(`/v1/memory/people/${encodeURIComponent(selectedPerson)}/facts/${factId}`)
      await loadPerson(selectedPerson)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function addDiary() {
    if (!diaryDraft.trim()) return
    try {
      await apiPost('/v1/memory/diary', { text: diaryDraft.trim() })
      setDiaryDraft('')
      setStatus('Запись дневника добавлена')
      await load()
      setSelectedNote(0)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function addJournal() {
    if (!journalDraft.trim()) return
    try {
      await apiPost('/v1/memory/journal', {
        text: journalDraft.trim(),
        title: journalTitle.trim() || undefined,
        kind: 'manual',
      })
      setJournalDraft('')
      setJournalTitle('')
      setStatus('Запись журнала добавлена')
      await load()
      setSelectedJournal(0)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

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

  const sortedPeople = useMemo(
    () => [...people].sort((a, b) => personLabel(a).localeCompare(personLabel(b), 'ru')),
    [people],
  )

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
      {status && <InlineFeedback tone="success">{status}</InlineFeedback>}

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
            <div className="card-header" style={{ justifyContent: 'space-between' }}>
              <span className="card-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <Users size={15} className="card-icon" /> Список ({people.length})
              </span>
              <Button
                onClick={() => {
                  setCreating(true)
                  setSelectedPerson('')
                  setProfile(emptyProfile())
                  setAliases('')
                  setDiscordIds('')
                  setFacts([])
                  setLegacyHints([])
                }}
                size="sm"
                type="button"
                variant="cyan"
              >
                <Plus size={14} /> Новый
              </Button>
            </div>
            <div className="stack-sm">
              {sortedPeople.map((p) => (
                <button
                  key={String(p.id)}
                  className={`plugin-item${selectedPerson === String(p.id) && !creating ? ' active' : ''}`}
                  onClick={() => {
                    setCreating(false)
                    setSelectedPerson(String(p.id))
                  }}
                  type="button"
                >
                  <span>{personLabel(p)}</span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: '0.7rem', color: 'var(--muted)' }}>{p.id}</span>
                </button>
              ))}
              {people.length === 0 && <EmptyState icon={Users} title="Нет людей" description="Добавь первого человека." />}
            </div>
          </div>

          <div className="card person-editor">
            <div className="card-header">
              <span className="card-title">{creating ? 'Новый человек' : 'Карточка'}</span>
            </div>
            {!creating && !selectedPerson ? (
              <p style={{ color: 'var(--muted)', fontSize: '0.85rem' }}>Выбери человека слева или создай нового.</p>
            ) : (
              <div className="stack">
                {creating && (
                  <label className="label">
                    <span className="label-text">ID (латиница, необязательно)</span>
                    <input className="input input-mono" onChange={(e) => setNewPersonId(e.target.value)} value={newPersonId} />
                  </label>
                )}
                <div className="grid-2">
                  {PROFILE_FIELDS.map((f) => (
                    <label key={f.key} className="label">
                      <span className="label-text">{f.label}</span>
                      <input
                        className="input"
                        onChange={(e) => setProfile((p) => ({ ...p, [f.key]: e.target.value }))}
                        placeholder={f.placeholder}
                        value={profile[f.key] || ''}
                      />
                    </label>
                  ))}
                </div>
                <label className="label">
                  <span className="label-text">Псевдонимы (через запятую)</span>
                  <input className="input" onChange={(e) => setAliases(e.target.value)} value={aliases} />
                </label>
                <label className="label">
                  <span className="label-text">Discord ID (через запятую)</span>
                  <input className="input input-mono" onChange={(e) => setDiscordIds(e.target.value)} value={discordIds} />
                </label>
                <div className="row" style={{ flexWrap: 'wrap' }}>
                  {creating ? (
                    <Button onClick={() => void createPerson()} type="button">
                      Создать
                    </Button>
                  ) : (
                    <>
                      <Button onClick={() => void savePerson()} type="button">
                        Сохранить карточку
                      </Button>
                      <Button onClick={() => void deletePerson()} type="button" variant="warn">
                        <Trash2 size={14} /> Удалить
                      </Button>
                    </>
                  )}
                </div>

                {!creating && selectedPerson && (
                  <>
                    <div className="card-header" style={{ marginTop: '0.5rem', padding: 0 }}>
                      <span className="card-title">Факты</span>
                    </div>
                    <p style={{ fontSize: '0.78rem', color: 'var(--muted)', lineHeight: 1.45 }}>
                      Свободные заметки: машина, игры, привычки, табу — всё сюда. В сводке только общие поля выше.
                    </p>
                    {legacyHints.length > 0 && (
                      <div className="legacy-hints">
                        <p className="stat-label">Старые поля (перенеси в факты при желании)</p>
                        <ul>
                          {legacyHints.map((h) => (
                            <li key={h}>{h}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    <div className="facts-list">
                      {facts.map((f) => (
                        <div key={String(f.id)} className="fact-row">
                          <div>
                            <p style={{ fontSize: '0.85rem' }}>{f.fact}</p>
                            <p style={{ fontSize: '0.7rem', color: 'var(--muted)', fontFamily: 'var(--mono)' }}>
                              {String(f.created_at || '').slice(0, 19)}
                            </p>
                          </div>
                          {f.id != null && (
                            <button
                              aria-label="Удалить факт"
                              className="btn btn-secondary btn-sm btn-danger"
                              onClick={() => void removeFact(Number(f.id))}
                              type="button"
                            >
                              <Trash2 size={13} />
                            </button>
                          )}
                        </div>
                      ))}
                      {facts.length === 0 && <p style={{ color: 'var(--muted)', fontSize: '0.8rem' }}>Фактов пока нет.</p>}
                    </div>
                    <div className="row" style={{ alignItems: 'flex-end' }}>
                      <label className="label" style={{ flex: 1 }}>
                        <span className="label-text">Новый факт</span>
                        <input className="input" onChange={(e) => setNewFact(e.target.value)} value={newFact} />
                      </label>
                      <Button onClick={() => void addFact()} type="button" variant="cyan">
                        Добавить
                      </Button>
                    </div>
                  </>
                )}
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
            <label className="label" style={{ marginBottom: '0.75rem' }}>
              <span className="label-text">Новая запись</span>
              <textarea className="textarea" onChange={(e) => setDiaryDraft(e.target.value)} rows={3} value={diaryDraft} />
            </label>
            <Button onClick={() => void addDiary()} style={{ marginBottom: '0.85rem' }} type="button">
              Добавить в дневник
            </Button>
            <div className="stack-sm" style={{ marginBottom: '0.75rem', maxHeight: 180, overflow: 'auto' }}>
              {diary.map((n, i) => (
                <button
                  key={i}
                  className={`plugin-item${selectedNote === i ? ' active' : ''}`}
                  onClick={() => setSelectedNote(i)}
                  type="button"
                >
                  <span style={{ fontSize: '0.8rem' }}>
                    {String(n.title || n.ts || n.created_at || n.date || `Запись ${i + 1}`)}
                  </span>
                </button>
              ))}
              {diary.length === 0 && <EmptyState icon={NotebookPen} title="Пусто" description="Нет заметок дневника." />}
            </div>
            <pre className="code-block" style={{ maxHeight: 220, overflow: 'auto' }}>
              {diary[selectedNote] ? String(diary[selectedNote].text || JSON.stringify(diary[selectedNote], null, 2)) : '—'}
            </pre>
          </div>
          <div className="card">
            <div className="card-header">
              <span className="card-title">Журнал ядра ({journal.length})</span>
            </div>
            <label className="label">
              <span className="label-text">Заголовок</span>
              <input className="input" onChange={(e) => setJournalTitle(e.target.value)} value={journalTitle} />
            </label>
            <label className="label" style={{ marginBottom: '0.75rem' }}>
              <span className="label-text">Текст</span>
              <textarea className="textarea" onChange={(e) => setJournalDraft(e.target.value)} rows={3} value={journalDraft} />
            </label>
            <Button onClick={() => void addJournal()} style={{ marginBottom: '0.85rem' }} type="button">
              Добавить в журнал
            </Button>
            <div className="stack-sm" style={{ marginBottom: '0.75rem', maxHeight: 180, overflow: 'auto' }}>
              {journal.map((n, i) => (
                <button
                  key={i}
                  className={`plugin-item${selectedJournal === i ? ' active' : ''}`}
                  onClick={() => setSelectedJournal(i)}
                  type="button"
                >
                  <span style={{ fontSize: '0.8rem' }}>
                    {String(n.title || n.kind || n.type || n.ts || `Событие ${i + 1}`)}
                  </span>
                </button>
              ))}
              {journal.length === 0 && <EmptyState icon={BookOpen} title="Пусто" description="Нет записей журнала." />}
            </div>
            <pre className="code-block" style={{ maxHeight: 220, overflow: 'auto' }}>
              {journal[selectedJournal]
                ? String(journal[selectedJournal].text || JSON.stringify(journal[selectedJournal], null, 2))
                : '—'}
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
