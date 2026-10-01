import { useCallback, useEffect, useState } from 'react'
import { Brain, Search, Users } from 'lucide-react'
import { apiGet, apiPost } from '../api'
import type { ApiEnvelope, MemoryPolicies, MemoryStats } from '../api'
import { Button } from '../components/ui/button'
import { InlineFeedback } from '../components/ui/inline-feedback'
import { PageHeader } from '../components/ui/page-header'
import { Skeleton } from '../components/ui/skeleton'

export function MemoryScreen() {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [memory, setMemory] = useState<MemoryStats | null>(null)
  const [memPolicies, setMemPolicies] = useState<MemoryPolicies | null>(null)
  const [people, setPeople] = useState<unknown[]>([])
  const [diary, setDiary] = useState<unknown[]>([])
  const [journal, setJournal] = useState<unknown[]>([])
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
        apiGet<ApiEnvelope<{ people?: unknown[] } | unknown[]>>('/v1/memory/people'),
        apiGet<ApiEnvelope<{ notes?: unknown[] } | unknown[]>>('/v1/memory/diary'),
        apiGet<ApiEnvelope<{ entries?: unknown[] } | unknown[]>>('/v1/memory/journal'),
      ])
      setMemory(m.data)
      setMemPolicies(pol.data)
      const peData = pe.data as { people?: unknown[] } | unknown[]
      setPeople(Array.isArray(peData) ? peData : peData.people ?? [])
      const diData = di.data as { notes?: unknown[] } | unknown[]
      setDiary(Array.isArray(diData) ? diData : diData.notes ?? [])
      const joData = jo.data as { entries?: unknown[] } | unknown[]
      setJournal(Array.isArray(joData) ? joData : joData.entries ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function runSearch() {
    setError(null)
    try {
      const r = await apiPost<ApiEnvelope<{ results?: unknown[]; hits?: unknown[] }>>('/v1/memory/search', {
        query: searchQ,
        limit: 20,
      })
      setSearchHits(r.data.results ?? r.data.hits ?? (Array.isArray(r.data) ? (r.data as unknown[]) : []))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function runLtm(path: '/v1/memory/prune' | '/v1/memory/summarize', body: Record<string, unknown>) {
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

  return (
    <div className="page-content stack">
      <PageHeader
        title="Память"
        subtitle="Статистика Hub, поиск, люди, дневник и LTM"
        actions={
          <Button disabled={loading} onClick={() => void load()} type="button" variant="cyan">
            {loading ? 'Обновление…' : 'Обновить'}
          </Button>
        }
      />
      {error && <InlineFeedback tone="error">{error}</InlineFeedback>}

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
              { label: 'STM', value: memory?.short_memory_size },
              { label: 'Chroma', value: memory?.hub?.chroma_records ?? memory?.long_memory_records },
              { label: 'Люди', value: memory?.people_records ?? memory?.hub?.people },
              { label: 'Журнал чата', value: memory?.hub?.chat_log },
              { label: 'Дневник', value: memory?.hub?.diary_notes },
              { label: 'RAG mode', value: memory?.hub?.rag_write_mode },
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
          <Search size={15} className="card-icon" />
          <span className="card-title">Поиск</span>
        </div>
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
          <pre className="code-block" style={{ maxHeight: 240, overflow: 'auto' }}>
            {JSON.stringify(searchHits, null, 2)}
          </pre>
        )}
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-header">
            <Users size={15} className="card-icon" />
            <span className="card-title">Люди ({people.length})</span>
          </div>
          <pre className="code-block" style={{ maxHeight: 200, overflow: 'auto' }}>
            {JSON.stringify(people.slice(0, 20), null, 2)}
          </pre>
        </div>
        <div className="card">
          <div className="card-header">
            <span className="card-title">Дневник / журнал</span>
          </div>
          <pre className="code-block" style={{ maxHeight: 200, overflow: 'auto' }}>
            {JSON.stringify({ diary: diary.slice(0, 10), journal: journal.slice(0, 10) }, null, 2)}
          </pre>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <Brain size={15} className="card-icon" />
          <span className="card-title">Обслуживание LTM</span>
        </div>
        <p style={{ fontSize: '0.8rem', color: 'var(--muted)', marginBottom: '1rem' }}>Нужна роль maint или admin.</p>
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
          <Button disabled={ltmBusy} onClick={() => void runLtm('/v1/memory/prune', { older_than_days: Number(pruneDays) || 90, dry_run: true })} type="button" variant="secondary">
            Очистка (dry-run)
          </Button>
          <Button disabled={ltmBusy} onClick={() => void runLtm('/v1/memory/prune', { older_than_days: Number(pruneDays) || 90, dry_run: false })} type="button" variant="warn">
            Очистка
          </Button>
          <Button
            disabled={ltmBusy}
            onClick={() =>
              void runLtm('/v1/memory/summarize', {
                older_than_days: Number(sumDays) || 60,
                dry_run: true,
                max_entries: 500,
                compress_with_llm: sumCompress,
              })
            }
            type="button"
            variant="secondary"
          >
            Сумм. (dry-run)
          </Button>
          <Button
            disabled={ltmBusy}
            onClick={() =>
              void runLtm('/v1/memory/summarize', {
                older_than_days: Number(sumDays) || 60,
                dry_run: false,
                max_entries: 500,
                compress_with_llm: sumCompress,
              })
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
    </div>
  )
}
