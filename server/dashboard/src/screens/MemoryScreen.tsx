import { useCallback, useEffect, useMemo, useState } from 'react'
import { BookOpen, Brain, NotebookPen, Plus, Search, Trash2, Users } from 'lucide-react'
import { apiDelete, apiGet, apiPatch, apiPost } from '../api'
import type { ApiEnvelope, MemoryPolicies, MemoryStats } from '../api'
import { Button } from '../components/ui/button'
import { DangerConfirmDialog } from '../components/ui/danger-confirm-dialog'
import { EmptyState } from '../components/ui/empty-state'
import { InlineFeedback } from '../components/ui/inline-feedback'
import { PageHeader } from '../components/ui/page-header'
import { Skeleton } from '../components/ui/skeleton'

type MemoryDanger =
  | { kind: 'delete-person'; id: string }
  | { kind: 'merge'; source: string; target: string }
  | { kind: 'apply-proposal'; id: number }
  | { kind: 'undo-merge'; id: number }
  | { kind: 'delete-diary'; id: number }
  | { kind: 'delete-journal'; id: number }
  | { kind: 'wipe'; scopes: string[]; label: string }
  | { kind: 'ltm'; path: '/v1/memory/prune' | '/v1/memory/summarize'; body: Record<string, unknown> }

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
  const [slugDuplicates, setSlugDuplicates] = useState<
    { slug_person_id?: string; related_person_ids?: string[]; hint?: string }[]
  >([])
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
  const [lastMergeLogId, setLastMergeLogId] = useState<number | null>(null)
  const [recentMerges, setRecentMerges] = useState<
    { id?: number; survivor_id?: string; source_id?: string; undone_at?: string | null }[]
  >([])
  const [danger, setDanger] = useState<MemoryDanger | null>(null)
  const [dangerBusy, setDangerBusy] = useState(false)
  const [peopleQuery, setPeopleQuery] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [m, pol, pe, di, jo, pr, ml] = await Promise.all([
        apiGet<ApiEnvelope<MemoryStats>>('/v1/memory/stats'),
        apiGet<ApiEnvelope<MemoryPolicies>>('/v1/memory/policies'),
        apiGet<
          ApiEnvelope<{
            people: PersonRow[]
            slug_duplicates?: { slug_person_id?: string; related_person_ids?: string[]; hint?: string }[]
          }>
        >('/v1/memory/people'),
        apiGet<ApiEnvelope<{ notes: DiaryNote[] }>>('/v1/memory/diary?limit=50'),
        apiGet<ApiEnvelope<{ entries: JournalEntry[] }>>('/v1/memory/journal?limit=50'),
        apiGet<ApiEnvelope<{ proposals: MergeProposal[] }>>('/v1/memory/people/merge-proposals?status=pending'),
        apiGet<ApiEnvelope<{ merges: { id?: number; survivor_id?: string; source_id?: string; undone_at?: string | null }[] }>>(
          '/v1/memory/people/merge-log?limit=10',
        ),
      ])
      setMemory(m.data)
      setMemPolicies(pol.data)
      const plist = pe.data.people ?? []
      setPeople(plist)
      setSlugDuplicates(pe.data.slug_duplicates ?? [])
      setDiary(di.data.notes ?? [])
      setJournal(jo.data.entries ?? [])
      setProposals(pr.data.proposals ?? [])
      setRecentMerges(ml.data.merges ?? [])
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
    setDanger({ kind: 'delete-person', id: selectedPerson })
  }

  async function mergeIntoSelected() {
    if (!selectedPerson || !mergeSource.trim()) return
    setDanger({ kind: 'merge', source: mergeSource.trim(), target: selectedPerson })
  }

  async function applyProposal(id: number) {
    setDanger({ kind: 'apply-proposal', id })
  }

  async function rejectProposal(id: number) {
    try {
      await apiPost(`/v1/memory/people/merge-proposals/${id}/reject`, {})
      setStatus(`Заявка #${id} отклонена`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      await load()
    }
  }

  async function undoMerge(mergeLogId: number) {
    setDanger({ kind: 'undo-merge', id: mergeLogId })
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
    setDanger({ kind: 'delete-diary', id: nid })
  }

  async function deleteJournalEntry(id: unknown) {
    const nid = Number(id)
    if (!Number.isFinite(nid)) return
    setDanger({ kind: 'delete-journal', id: nid })
  }

  async function runWipe(scopes: string[], label: string) {
    setDanger({ kind: 'wipe', scopes, label })
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
    if (destructive) {
      setDanger({ kind: 'ltm', path, body })
      return
    }
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

  async function confirmDanger() {
    if (!danger) return
    setDangerBusy(true)
    setError(null)
    try {
      switch (danger.kind) {
        case 'delete-person': {
          await apiDelete(`/v1/memory/people/${encodeURIComponent(danger.id)}`)
          setSelectedPerson('')
          setStatus('Удалено')
          await load()
          break
        }
        case 'merge': {
          const r = await apiPost<ApiEnvelope<{ merge_log_id?: number; survivor_id?: string }>>(
            '/v1/memory/people/merge',
            { survivor_id: danger.target, source_id: danger.source, reason: 'dashboard_merge' },
          )
          const mid = Number(r.data?.merge_log_id)
          if (Number.isFinite(mid)) setLastMergeLogId(mid)
          setMergeSource('')
          setStatus(Number.isFinite(mid) ? `Скрещены (merge_log #${mid})` : 'Карточки скрещены')
          await load()
          await loadPerson(danger.target)
          break
        }
        case 'apply-proposal': {
          const r = await apiPost<ApiEnvelope<{ merge?: { merge_log_id?: number } }>>(
            `/v1/memory/people/merge-proposals/${danger.id}/apply`,
            {},
          )
          const mid = Number(r.data?.merge?.merge_log_id)
          if (Number.isFinite(mid)) setLastMergeLogId(mid)
          setStatus(
            Number.isFinite(mid) ? `Заявка #${danger.id} → merge_log #${mid}` : `Заявка #${danger.id} применена`,
          )
          await load()
          break
        }
        case 'undo-merge': {
          await apiPost(`/v1/memory/people/merge/${danger.id}/undo`, {})
          setStatus(`Merge #${danger.id} отменён`)
          if (lastMergeLogId === danger.id) setLastMergeLogId(null)
          await load()
          break
        }
        case 'delete-diary': {
          await apiDelete(`/v1/memory/diary/${danger.id}`)
          await load()
          break
        }
        case 'delete-journal': {
          await apiDelete(`/v1/memory/journal/${danger.id}`)
          await load()
          break
        }
        case 'wipe': {
          setWipeBusy(true)
          await apiPost('/v1/memory/wipe', { scopes: danger.scopes, confirm: 'WIPE' })
          setStatus(`Очищено: ${danger.label}`)
          await load()
          break
        }
        case 'ltm': {
          setLtmBusy(true)
          setLtmMsg(null)
          const r = await apiPost<ApiEnvelope<unknown>>(danger.path, danger.body)
          setLtmMsg(JSON.stringify(r.data, null, 2))
          await load()
          break
        }
      }
      setDanger(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setDanger(null)
    } finally {
      setDangerBusy(false)
      setWipeBusy(false)
      setLtmBusy(false)
    }
  }

  const dangerCopy = (() => {
    if (!danger) return { title: '', description: '', phrase: 'УДАЛИТЬ' }
    switch (danger.kind) {
      case 'delete-person':
        return {
          title: 'Удалить карточку?',
          description: `Удалить «${danger.id}» и все факты. Действие необратимо.`,
          phrase: 'УДАЛИТЬ',
        }
      case 'merge':
        return {
          title: 'Скрестить карточки?',
          description: `${danger.source} → ${danger.target}. Source будет удалён (можно отменить).`,
          phrase: 'СКРЕСТИТЬ',
        }
      case 'apply-proposal':
        return {
          title: `Применить заявку #${danger.id}?`,
          description: 'person_a станет survivor (можно отменить).',
          phrase: 'ПРИМЕНИТЬ',
        }
      case 'undo-merge':
        return {
          title: `Отменить merge #${danger.id}?`,
          description: 'Карточки и факты вернутся к состоянию до слияния.',
          phrase: 'ОТМЕНИТЬ',
        }
      case 'delete-diary':
        return { title: 'Удалить запись дневника?', description: 'Запись будет удалена без восстановления.', phrase: 'УДАЛИТЬ' }
      case 'delete-journal':
        return { title: 'Удалить запись журнала?', description: 'Запись будет удалена без восстановления.', phrase: 'УДАЛИТЬ' }
      case 'wipe':
        return {
          title: `Очистить ${danger.label}?`,
          description: 'Необратимая очистка выбранных областей памяти.',
          phrase: 'WIPE',
        }
      case 'ltm':
        return {
          title: 'Изменить долгосрочную память?',
          description: 'Очистка или суммаризация изменит LTM.',
          phrase: 'ПРОДОЛЖИТЬ',
        }
    }
  })()

  const sortedPeople = useMemo(() => {
    const q = peopleQuery.trim().toLowerCase()
    return [...people]
      .filter((p) => {
        if (!q) return true
        const hay = [
          p.id,
          p.display_name,
          ...(p.names ?? []),
          ...(p.aliases ?? []),
          ...(p.accounts ?? []).flatMap((a) => [a.handle, a.display_name, a.platform_user_id]),
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
        return hay.includes(q)
      })
      .sort((a, b) => personLabel(a).localeCompare(personLabel(b), 'ru'))
  }, [people, peopleQuery])

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

      <div className="panel-tabs panel-tabs-dense panel-tabs-standalone" role="tablist" aria-label="Разделы памяти">
        {(
          [
            ['overview', 'Обзор', Brain],
            ['people', 'Люди', Users],
            ['diary', 'Дневник / журнал', NotebookPen],
            ['search', 'Поиск RAG', Search],
            ['ltm', 'Долгая память', BookOpen],
          ] as const
        ).map(([id, label, Icon]) => (
          <button
            key={id}
            aria-selected={tab === id}
            className={`panel-tab${tab === id ? ' active' : ''}`}
            onClick={() => setTab(id)}
            role="tab"
            type="button"
          >
            <Icon aria-hidden size={14} /> {label}
          </button>
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
                  { label: 'Люди', value: memory?.people_records ?? memory?.hub?.people },
                  { label: 'Факты', value: memory?.hub?.person_facts },
                  { label: 'Chroma (RAG)', value: memory?.hub?.chroma_records ?? memory?.long_memory_records },
                  { label: 'Дневник', value: memory?.hub?.diary_notes },
                  { label: 'Журнал', value: memory?.hub?.journal_entries },
                  { label: 'Режим RAG', value: memory?.hub?.rag_write_mode ?? (memory?.hub?.rag_enabled === false ? 'off' : '—') },
                  { label: 'STM', value: memory?.short_memory_size },
                  { label: 'Журнал чата', value: memory?.hub?.chat_log },
                ].map(({ label, value }) => (
                  <div key={label} className="stat-tile">
                    <p className="stat-label">{label}</p>
                    <p className="stat-value-md tabular-nums">{value ?? '—'}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="card" style={{ borderColor: 'color-mix(in oklab, var(--danger) 35%, var(--border))' }}>
            <div className="card-header">
              <Trash2 size={15} className="card-icon" style={{ color: 'var(--danger)' }} />
              <span className="card-title">Опасная зона · wipe</span>
            </div>
            <p style={{ fontSize: '0.8rem', color: 'var(--muted)', marginBottom: '0.85rem', lineHeight: 1.45 }}>
              Необратимо. Перед wipe на стенде сделай бэкап. Подтверждение — фраза <code className="inline-code">WIPE</code>.
            </p>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <Button disabled={wipeBusy} onClick={() => void runWipe(['diary'], 'дневник')} type="button" variant="warn">
                Дневник
              </Button>
              <Button disabled={wipeBusy} onClick={() => void runWipe(['journal'], 'журнал')} type="button" variant="warn">
                Журнал
              </Button>
              <Button disabled={wipeBusy} onClick={() => void runWipe(['people'], 'людей')} type="button" variant="warn">
                Люди
              </Button>
              <Button disabled={wipeBusy} onClick={() => void runWipe(['ltm'], 'Chroma LTM')} type="button" variant="warn">
                LTM
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
                variant="danger"
              >
                Вся память
              </Button>
            </div>
          </div>
        </div>
      )}

      {tab === 'people' && (
        <div className="split-modules">
          {slugDuplicates.length > 0 && (
            <div className="card" style={{ gridColumn: '1 / -1', borderColor: 'var(--amber)' }}>
              <div className="card-header">
                <span className="card-title">Дубли: nick как id</span>
              </div>
              <p className="text-muted" style={{ margin: '0 0 0.5rem', fontSize: '0.85rem' }}>
                Карточки с id-ником (не UUID) рядом с Discord-персонами. Склейте через merge — аккаунты
                больше не переезжают молча.
              </p>
              <div className="stack-sm">
                {slugDuplicates.map((d) => (
                  <div key={String(d.slug_person_id)} className="row-between">
                    <span style={{ fontFamily: 'var(--mono)', fontSize: '0.78rem' }}>
                      {d.slug_person_id} ↔ {(d.related_person_ids || []).join(', ')}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
              {(proposals.length > 0 || recentMerges.some((m) => !m.undone_at)) && (
            <div className="card" style={{ gridColumn: '1 / -1' }}>
              <div className="card-header">
                <span className="card-title">Предложения объединения и undo</span>
              </div>
              <div className="stack-sm">
                {proposals.map((p) => {
                  const left = people.find((x) => String(x.id) === String(p.person_a))
                  const right = people.find((x) => String(x.id) === String(p.person_b))
                  return (
                    <div key={String(p.id)} className="merge-proposal-card">
                      <div className="merge-proposal-sides">
                        <div className="merge-proposal-side">
                          <p className="stat-label">A → survivor</p>
                          <p className="mono" style={{ fontSize: '0.8rem' }}>
                            {left ? personLabel(left) : p.person_a}
                          </p>
                          <p className="hint mono">{p.person_a}</p>
                        </div>
                        <span className="hint" aria-hidden>
                          ↔
                        </span>
                        <div className="merge-proposal-side">
                          <p className="stat-label">B → source</p>
                          <p className="mono" style={{ fontSize: '0.8rem' }}>
                            {right ? personLabel(right) : p.person_b}
                          </p>
                          <p className="hint mono">{p.person_b}</p>
                        </div>
                      </div>
                      {p.reason ? <p className="hint">{p.reason}</p> : null}
                      <div className="row">
                        <Button onClick={() => void applyProposal(Number(p.id))} size="sm" type="button" variant="cyan">
                          Объединить
                        </Button>
                        <Button onClick={() => void rejectProposal(Number(p.id))} size="sm" type="button" variant="secondary">
                          Отклонить
                        </Button>
                      </div>
                    </div>
                  )
                })}
                {recentMerges
                  .filter((m) => m.id != null && !m.undone_at)
                  .slice(0, 5)
                  .map((m) => (
                    <div key={`ml-${m.id}`} className="row-between">
                      <span style={{ fontFamily: 'var(--mono)', fontSize: '0.78rem' }}>
                        merge_log #{m.id}: {m.source_id} → {m.survivor_id}
                      </span>
                      <Button onClick={() => void undoMerge(Number(m.id))} size="sm" type="button" variant="warn">
                        Отменить
                      </Button>
                    </div>
                  ))}
                {lastMergeLogId != null && (
                  <p style={{ fontSize: '0.78rem', color: 'var(--muted)' }}>
                    Последний merge_log: #{lastMergeLogId}
                  </p>
                )}
              </div>
            </div>
          )}
          <div className="card" style={{ height: 'fit-content' }}>
            <div className="card-header" style={{ justifyContent: 'space-between' }}>
              <span className="card-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <Users size={15} className="card-icon" /> Список ({sortedPeople.length}
                {sortedPeople.length !== people.length ? ` / ${people.length}` : ''})
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
            <input
              aria-label="Поиск людей"
              className="input"
              onChange={(e) => setPeopleQuery(e.target.value)}
              placeholder="Поиск: id, ник, alias…"
              style={{ marginBottom: '0.5rem', minHeight: 36 }}
              value={peopleQuery}
            />
            <div className="stack-sm">
              {sortedPeople.map((p) => {
                const avatar = (p.accounts || []).find((a) => a.avatar_url)?.avatar_url
                return (
                  <button
                    key={String(p.id)}
                    aria-current={selectedPerson === String(p.id) && !creating ? 'true' : undefined}
                    className={`plugin-item${selectedPerson === String(p.id) && !creating ? ' active' : ''}`}
                    onClick={() => {
                      setCreating(false)
                      setSelectedPerson(String(p.id))
                    }}
                    title={String(p.id)}
                    type="button"
                  >
                    <span className="row" style={{ gap: 8, minWidth: 0 }}>
                      {avatar ? (
                        <img
                          alt=""
                          className="person-avatar"
                          height={28}
                          loading="lazy"
                          src={avatar}
                          width={28}
                        />
                      ) : null}
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{personLabel(p)}</span>
                    </span>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: '0.7rem', color: 'var(--muted)' }} title={String(p.id)}>
                      {String(p.id || '').length > 18 ? `${String(p.id).slice(0, 16)}…` : p.id}
                    </span>
                  </button>
                )
              })}
              {people.length === 0 && <EmptyState icon={Users} title="Нет людей" description="Карточки появятся из Discord или создай вручную." />}
              {people.length > 0 && sortedPeople.length === 0 && (
                <EmptyState icon={Users} title="Ничего не найдено" description="Сбрось поисковую строку." />
              )}
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
                      <div key={i} className="row" style={{ gap: 8, alignItems: 'center' }}>
                        {a.avatar_url ? (
                          <img
                            alt={a.display_name || a.handle || a.platform_user_id || 'avatar'}
                            className="person-avatar"
                            height={28}
                            loading="lazy"
                            src={a.avatar_url}
                            width={28}
                          />
                        ) : null}
                        <p style={{ fontSize: '0.8rem', fontFamily: 'var(--mono)', margin: 0 }}>
                          {a.platform}:{a.platform_user_id}
                          {a.handle ? ` @${a.handle}` : ''}
                          {a.display_name ? ` (${a.display_name})` : ''}
                        </p>
                      </div>
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
                    <Button
                      aria-label={`Удалить запись дневника ${String(n.id)}`}
                      onClick={() => void deleteDiaryNote(n.id)}
                      size="sm"
                      type="button"
                      variant="secondary"
                    >
                      <Trash2 aria-hidden size={13} />
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
                    <Button
                      aria-label={`Удалить запись журнала ${String(n.id)}`}
                      onClick={() => void deleteJournalEntry(n.id)}
                      size="sm"
                      type="button"
                      variant="secondary"
                    >
                      <Trash2 aria-hidden size={13} />
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

      <DangerConfirmDialog
        busy={dangerBusy}
        confirmLabel="Подтвердить"
        confirmPhrase={dangerCopy.phrase}
        description={dangerCopy.description}
        onCancel={() => !dangerBusy && setDanger(null)}
        onConfirm={() => void confirmDanger()}
        open={danger != null}
        title={dangerCopy.title}
      />
    </div>
  )
}
