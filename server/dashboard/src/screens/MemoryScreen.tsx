import { useCallback, useEffect, useMemo, useState } from 'react'
import { BookOpen, Brain, NotebookPen, Plus, Search, Trash2, Users } from 'lucide-react'
import { apiDelete, apiGet, apiPatch, apiPost } from '../api'
import type { ApiEnvelope, MemoryPolicies, MemoryStats } from '../api'
import { Button } from '../components/ui/button'
import { EmptyState } from '../components/ui/empty-state'
import { InlineFeedback } from '../components/ui/inline-feedback'
import { PageHeader } from '../components/ui/page-header'
import { Skeleton } from '../components/ui/skeleton'

type PersonAccount = {
  platform?: string
  platform_user_id?: string
  handle?: string
  display_name?: string
  avatar_url?: string
}

type PersonRow = {
  id?: string
  names?: string[]
  aliases?: string[]
  discord_ids?: string[]
  accounts?: PersonAccount[]
  display_name?: string
}

type PersonFact = { id?: number; fact?: string; created_at?: string; emotion_note?: string }
type MergeProposal = {
  id?: number
  person_a?: string
  person_b?: string
  reason?: string
  status?: string
}
type DiaryNote = Record<string, unknown>
type JournalEntry = Record<string, unknown>

export function MemoryScreen() {
  const [tab, setTab] = useState<'overview' | 'people' | 'diary' | 'search' | 'ltm'>('overview')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const [memory, setMemory] = useState<MemoryStats | null>(null)
  const [memPolicies, setMemPolicies] = useState<MemoryPolicies | null>(null)
  const [people, setPeople] = useState<PersonRow[]>([])
  const [selectedPerson, setSelectedPerson] = useState('')
  const [aliasesText, setAliasesText] = useState('')
  const [facts, setFacts] = useState<PersonFact[]>([])
  const [summary, setSummary] = useState('')
  const [accounts, setAccounts] = useState<PersonAccount[]>([])
  const [newFact, setNewFact] = useState('')
  const [creating, setCreating] = useState(false)
  const [newPersonId, setNewPersonId] = useState('')
  const [mergeSource, setMergeSource] = useState('')
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
  const [wipeBusy, setWipeBusy] = useState(false)
  const [proposals, setProposals] = useState<MergeProposal[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [m, pol, pe, di, jo, pr] = await Promise.all([
        apiGet<ApiEnvelope<MemoryStats>>('/v1/memory/stats'),
        apiGet<ApiEnvelope<MemoryPolicies>>('/v1/memory/policies'),
        apiGet<ApiEnvelope<{ people: PersonRow[] }>>('/v1/memory/people'),
        apiGet<ApiEnvelope<{ notes: DiaryNote[] }>>('/v1/memory/diary?limit=50'),
        apiGet<ApiEnvelope<{ entries: JournalEntry[] }>>('/v1/memory/journal?limit=50'),
        apiGet<ApiEnvelope<{ proposals: MergeProposal[] }>>('/v1/memory/people/merge-proposals?status=pending'),
      ])
      setMemory(m.data)
      setMemPolicies(pol.data)
      const plist = pe.data.people ?? []
      setPeople(plist)
      setDiary(di.data.notes ?? [])
      setJournal(jo.data.entries ?? [])
      setProposals(pr.data.proposals ?? [])
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
      setAliasesText('')
      setFacts([])
      setSummary('')
      setAccounts([])
      return
    }
    try {
      const r = await apiGet<
        ApiEnvelope<{
          person?: PersonRow | null
          accounts?: PersonAccount[]
          facts?: PersonFact[]
          summary?: string
        }>
      >(`/v1/memory/people/${encodeURIComponent(pid)}`)
      const person = r.data.person
      const names = person?.aliases || person?.names || []
      setAliasesText(names.join(', '))
      setFacts(r.data.facts ?? [])
      setSummary(r.data.summary || '')
      setAccounts(r.data.accounts || person?.accounts || [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void loadPerson(selectedPerson)
  }, [selectedPerson, loadPerson])

  const personLabel = (p: PersonRow) => {
    const disp = (p.display_name || '').trim()
    if (disp) return disp
    const names = (p.names ?? p.aliases ?? []).filter(Boolean)
    if (names[0]) return String(names[0])
    const acc = (p.accounts || [])[0]
    if (acc?.display_name) return String(acc.display_name)
    if (acc?.handle) return String(acc.handle)
    return p.id || '—'
  }

  async function savePerson() {
    if (!selectedPerson) return
    setStatus('')
    setError(null)
    try {
      const names = aliasesText
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      await apiPatch(`/v1/memory/people/${encodeURIComponent(selectedPerson)}`, { names })
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
      const names = aliasesText
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      const r = await apiPost<ApiEnvelope<{ person?: PersonRow }>>('/v1/memory/people', {
        id: newPersonId.trim() || undefined,
        names,
      })
      const id = String(r.data.person?.id || newPersonId || '')
      setCreating(false)
      setNewPersonId('')
      setAliasesText('')
      setStatus('Человек создан')
      await load()
      if (id) setSelectedPerson(id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function deletePerson() {
    if (!selectedPerson) return
    if (!window.confirm(`Удалить карточку «${selectedPerson}» и все факты?`)) return
    try {
      await apiDelete(`/v1/memory/people/${encodeURIComponent(selectedPerson)}`)
      setSelectedPerson('')
      setStatus('Удалено')
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function mergeIntoSelected() {
    if (!selectedPerson || !mergeSource.trim()) return
    if (!window.confirm(`Скрестить ${mergeSource.trim()} → ${selectedPerson}? Source будет удалён.`)) return
    try {
      await apiPost('/v1/memory/people/merge', {
        survivor_id: selectedPerson,
        source_id: mergeSource.trim(),
        reason: 'dashboard_merge',
      })
      setMergeSource('')
      setStatus('Карточки скрещены')
      await load()
      await loadPerson(selectedPerson)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function applyProposal(id: number) {
    if (!window.confirm(`Применить заявку #${id}? person_a станет survivor.`)) return
    try {
      await apiPost(`/v1/memory/people/merge-proposals/${id}/apply`, {})
      setStatus(`Заявка #${id} применена`)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function rejectProposal(id: number) {
    try {
      await apiPost(`/v1/memory/people/merge-proposals/${id}/reject`, {})
      setStatus(`Заявка #${id} отклонена`)
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

  async function deleteDiaryNote(id: unknown) {
    const nid = Number(id)
    if (!Number.isFinite(nid)) return
    if (!window.confirm('Удалить запись дневника?')) return
    try {
      await apiDelete(`/v1/memory/diary/${nid}`)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function deleteJournalEntry(id: unknown) {
    const nid = Number(id)
    if (!Number.isFinite(nid)) return
    if (!window.confirm('Удалить запись журнала?')) return
    try {
      await apiDelete(`/v1/memory/journal/${nid}`)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function runWipe(scopes: string[], label: string) {
    if (!window.confirm(`Очистить ${label}? Это необратимо.`)) return
    setWipeBusy(true)
    setError(null)
    try {
      await apiPost('/v1/memory/wipe', { scopes, confirm: 'WIPE' })
      setStatus(`Очищено: ${label}`)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setWipeBusy(false)
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
        subtitle="Люди (account-first), дневник, журнал и RAG"
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
        <div className="stack">
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
          <div className="card">
            <div className="card-header">
              <Trash2 size={15} className="card-icon" />
              <span className="card-title">Очистка памяти</span>
            </div>
            <p style={{ fontSize: '0.8rem', color: 'var(--muted)', marginBottom: '0.85rem', lineHeight: 1.45 }}>
              Cutover Memory v2: можно стереть слои по отдельности или всё сразу. Действия необратимы.
            </p>
            <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
              <Button disabled={wipeBusy} onClick={() => void runWipe(['diary'], 'дневник')} type="button" variant="warn">
                Очистить дневник
              </Button>
              <Button disabled={wipeBusy} onClick={() => void runWipe(['journal'], 'журнал')} type="button" variant="warn">
                Очистить журнал
              </Button>
              <Button disabled={wipeBusy} onClick={() => void runWipe(['people'], 'людей')} type="button" variant="warn">
                Очистить людей
              </Button>
              <Button
                disabled={wipeBusy}
                onClick={() =>
                  void runWipe(
                    ['people', 'diary', 'journal', 'stm', 'ltm', 'chat_log', 'working_memory'],
                    'ВСЮ память',
                  )
                }
                type="button"
                variant="warn"
              >
                Очистить всю память
              </Button>
            </div>
          </div>
        </div>
      )}

      {tab === 'people' && (
        <div className="split-modules">
          {proposals.length > 0 && (
            <div className="card" style={{ gridColumn: '1 / -1' }}>
              <div className="card-header">
                <span className="card-title">Кандидаты на merge ({proposals.length})</span>
              </div>
              <div className="stack-sm">
                {proposals.map((p) => (
                  <div
                    key={String(p.id)}
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: 8,
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <span style={{ fontFamily: 'var(--mono)', fontSize: '0.78rem' }}>
                      #{p.id}: {p.person_a} ↔ {p.person_b}
                      {p.reason ? ` — ${p.reason}` : ''}
                    </span>
                    <span style={{ display: 'inline-flex', gap: 6 }}>
                      <Button onClick={() => void applyProposal(Number(p.id))} size="sm" type="button" variant="cyan">
                        Склеить
                      </Button>
                      <Button onClick={() => void rejectProposal(Number(p.id))} size="sm" type="button" variant="ghost">
                        Отклонить
                      </Button>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="card" style={{ height: 'fit-content' }}>
            <div className="card-header" style={{ justifyContent: 'space-between' }}>
              <span className="card-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <Users size={15} className="card-icon" /> Список ({people.length})
              </span>
              <Button
                onClick={() => {
                  setCreating(true)
                  setSelectedPerson('')
                  setAliasesText('')
                  setFacts([])
                  setAccounts([])
                  setSummary('')
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
              {people.length === 0 && <EmptyState icon={Users} title="Нет людей" description="Карточки появятся из Discord или создай вручную." />}
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
                <label className="label">
                  <span className="label-text">Aliases / ники (через запятую)</span>
                  <input
                    className="input"
                    onChange={(e) => setAliasesText(e.target.value)}
                    placeholder="nick1, nick2"
                    value={aliasesText}
                  />
                </label>
                <p style={{ fontSize: '0.78rem', color: 'var(--muted)', lineHeight: 1.45 }}>
                  Анкеты нет. Имя, ДР, город и всё остальное — только свободные факты. Identity = Discord/Telegram accounts.
                </p>
                {!creating && accounts.length > 0 && (
                  <div className="stack-sm">
                    <p className="stat-label">Аккаунты</p>
                    {accounts.map((a, i) => (
                      <p key={i} style={{ fontSize: '0.8rem', fontFamily: 'var(--mono)' }}>
                        {a.platform}:{a.platform_user_id}
                        {a.handle ? ` @${a.handle}` : ''}
                        {a.display_name ? ` (${a.display_name})` : ''}
                      </p>
                    ))}
                  </div>
                )}
                {!creating && summary && (
                  <pre className="code-block" style={{ maxHeight: 140, overflow: 'auto', fontSize: '0.75rem' }}>
                    {summary}
                  </pre>
                )}
                <div className="row" style={{ flexWrap: 'wrap' }}>
                  {creating ? (
                    <Button onClick={() => void createPerson()} type="button">
                      Создать
                    </Button>
                  ) : (
                    <>
                      <Button onClick={() => void savePerson()} type="button">
                        Сохранить aliases
                      </Button>
                      <Button onClick={() => void deletePerson()} type="button" variant="warn">
                        <Trash2 size={14} /> Удалить
                      </Button>
                    </>
                  )}
                </div>

                {!creating && selectedPerson && (
                  <>
                    <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
                      <label className="label" style={{ flex: 1, minWidth: 180 }}>
                        <span className="label-text">Скрестить сюда (source id/ник)</span>
                        <input className="input input-mono" onChange={(e) => setMergeSource(e.target.value)} value={mergeSource} />
                      </label>
                      <Button onClick={() => void mergeIntoSelected()} type="button" variant="secondary">
                        Merge
                      </Button>
                    </div>
                    <div className="card-header" style={{ marginTop: '0.5rem', padding: 0 }}>
                      <span className="card-title">Факты</span>
                    </div>
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
                        <input
                          className="input"
                          onChange={(e) => setNewFact(e.target.value)}
                          placeholder="зовут Максим / город: Казань / …"
                          value={newFact}
                        />
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
            <div className="card-header" style={{ justifyContent: 'space-between' }}>
              <span className="card-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <NotebookPen size={15} className="card-icon" /> Дневник ({diary.length})
              </span>
              <Button disabled={wipeBusy} onClick={() => void runWipe(['diary'], 'дневник')} size="sm" type="button" variant="warn">
                Очистить
              </Button>
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
                <div key={i} className="row" style={{ gap: 6, alignItems: 'stretch' }}>
                  <button
                    className={`plugin-item${selectedNote === i ? ' active' : ''}`}
                    onClick={() => setSelectedNote(i)}
                    style={{ flex: 1 }}
                    type="button"
                  >
                    <span style={{ fontSize: '0.8rem' }}>
                      {String(n.title || n.ts || n.created_at || n.date || `Запись ${i + 1}`)}
                    </span>
                  </button>
                  {n.id != null && (
                    <Button onClick={() => void deleteDiaryNote(n.id)} size="sm" type="button" variant="secondary">
                      <Trash2 size={13} />
                    </Button>
                  )}
                </div>
              ))}
              {diary.length === 0 && <EmptyState icon={NotebookPen} title="Пусто" description="Нет заметок дневника." />}
            </div>
            <pre className="code-block" style={{ maxHeight: 220, overflow: 'auto' }}>
              {diary[selectedNote] ? String(diary[selectedNote].text || JSON.stringify(diary[selectedNote], null, 2)) : '—'}
            </pre>
          </div>
          <div className="card">
            <div className="card-header" style={{ justifyContent: 'space-between' }}>
              <span className="card-title">Журнал ядра ({journal.length})</span>
              <Button disabled={wipeBusy} onClick={() => void runWipe(['journal'], 'журнал')} size="sm" type="button" variant="warn">
                Очистить
              </Button>
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
                <div key={i} className="row" style={{ gap: 6, alignItems: 'stretch' }}>
                  <button
                    className={`plugin-item${selectedJournal === i ? ' active' : ''}`}
                    onClick={() => setSelectedJournal(i)}
                    style={{ flex: 1 }}
                    type="button"
                  >
                    <span style={{ fontSize: '0.8rem' }}>
                      {String(n.title || n.kind || n.type || n.ts || `Событие ${i + 1}`)}
                    </span>
                  </button>
                  {n.id != null && (
                    <Button onClick={() => void deleteJournalEntry(n.id)} size="sm" type="button" variant="secondary">
                      <Trash2 size={13} />
                    </Button>
                  )}
                </div>
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
            Семантический поиск по Chroma / Hub — не поиск по людям и не полнотекст дневника.
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
            <Button disabled={wipeBusy} onClick={() => void runWipe(['ltm'], 'Chroma LTM')} type="button" variant="warn">
              Wipe LTM
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
