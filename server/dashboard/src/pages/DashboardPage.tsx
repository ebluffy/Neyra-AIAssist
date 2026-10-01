import { useCallback, useEffect, useState } from 'react'
import { Activity, Brain, Database, RefreshCw, Wallet } from 'lucide-react'
import { apiGet, apiPost } from '../api'
import { Button } from '../components/ui/button'
import { EmptyState } from '../components/ui/empty-state'
import { InlineFeedback } from '../components/ui/inline-feedback'
import { Skeleton } from '../components/ui/skeleton'
import type { ApiEnvelope, BalanceData, HealthData, MemoryPolicies, MemoryStats, PluginRow, ProviderBalance } from '../types'

function fmtNum(v: unknown): string {
  if (v == null || v === '') return '—'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '—'
  return String(v)
}

function fmtBalanceValue(v: unknown, emptyHint?: string): string {
  if (v == null || v === '') return emptyHint ?? '—'
  return fmtNum(v)
}

function statusLabel(raw: string): string {
  const s = raw.toLowerCase()
  if (s === 'ok' || s === 'online' || s === 'healthy') return 'ок'
  if (s === 'degraded' || s === 'warn' || s === 'warning') return 'есть проблемы'
  if (s === 'unknown') return 'неизвестно'
  return raw
}

function formatUptime(sec: unknown): string {
  const n = typeof sec === 'number' ? sec : Number(sec)
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 60) return `${Math.floor(n)} с`
  if (n < 3600) return `${Math.floor(n / 60)} мин`
  const h = Math.floor(n / 3600)
  const m = Math.floor((n % 3600) / 60)
  return `${h} ч ${m} мин`
}

function ProviderBalanceBlock({ name, block }: { name: string; block: ProviderBalance }) {
  return (
    <div className="stack-sm" style={{ marginBottom: '0.75rem' }}>
      <p style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text)' }}>{name}</p>
      {block._error ? (
        <InlineFeedback tone="error">{block._error}{block.detail ? `: ${block.detail}` : ''}</InlineFeedback>
      ) : (
        <>
          <div className="grid-4">
            {[
              {
                label: 'Остаток',
                value: fmtBalanceValue(
                  block.limit_remaining,
                  block.limit == null ? 'без лимита' : '—',
                ),
              },
              {
                label: 'Лимит',
                value: fmtBalanceValue(block.limit, 'без лимита'),
              },
              { label: 'Израсходовано', value: fmtBalanceValue(block.usage) },
              { label: 'Метка', value: fmtBalanceValue(block.label) },
            ].map(({ label, value }) => (
              <div key={label} className="stat-tile">
                <p className="stat-label">{label}</p>
                <p className="stat-value-md">{value}</p>
              </div>
            ))}
          </div>
          {block.tokens_description ? (
            <p style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>{String(block.tokens_description)}</p>
          ) : null}
          <p style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>
            День / неделя / месяц:{' '}
            <span style={{ fontFamily: 'var(--mono)', color: 'var(--text)' }}>
              {fmtBalanceValue(block.usage_daily)} / {fmtBalanceValue(block.usage_weekly)} /{' '}
              {fmtBalanceValue(block.usage_monthly)}
            </span>
          </p>
        </>
      )}
    </div>
  )
}

export function DashboardPage() {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [health, setHealth] = useState<HealthData | null>(null)
  const [memory, setMemory] = useState<MemoryStats | null>(null)
  const [plugins, setPlugins] = useState<PluginRow[]>([])
  const [balance, setBalance] = useState<BalanceData | null>(null)
  const [memPolicies, setMemPolicies] = useState<MemoryPolicies | null>(null)
  const [ltmBusy, setLtmBusy] = useState(false)
  const [ltmMsg, setLtmMsg] = useState<string | null>(null)
  const [pruneDays, setPruneDays] = useState('90')
  const [sumDays, setSumDays] = useState('60')
  const [sumCompress, setSumCompress] = useState(true)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [h, m, p, b, pol] = await Promise.all([
        apiGet<ApiEnvelope<HealthData>>('/v1/health'),
        apiGet<ApiEnvelope<MemoryStats>>('/v1/memory/stats'),
        apiGet<ApiEnvelope<{ plugins: PluginRow[] }>>('/v1/plugins'),
        apiGet<ApiEnvelope<BalanceData>>('/v1/llm/balance'),
        apiGet<ApiEnvelope<MemoryPolicies>>('/v1/memory/policies'),
      ])
      setHealth(h.data); setMemory(m.data)
      setPlugins(p.data.plugins ?? [])
      setBalance(b.data); setMemPolicies(pol.data)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])

  async function runLtm(path: '/v1/memory/prune' | '/v1/memory/summarize', body: Record<string, unknown>) {
    setLtmBusy(true); setLtmMsg(null)
    try {
      const r = await apiPost<ApiEnvelope<unknown>>(path, body)
      setLtmMsg(JSON.stringify(r.data, null, 2))
      await load()
    } catch (e) { setLtmMsg(e instanceof Error ? e.message : String(e)) }
    finally { setLtmBusy(false) }
  }

  const rawStatus = String(
    (health?.status as string | undefined)
      ?? (health?.ok === true ? 'ok' : health?.ok === false ? 'degraded' : 'unknown'),
  ).toLowerCase()
  const isOk = rawStatus === 'ok' || rawStatus === 'online' || rawStatus === 'healthy'
  const isUnknown = rawStatus === 'unknown'
  const statusClass = isOk ? 'status-ok' : isUnknown ? 'status-idle' : 'status-warn'
  const dotClass = isOk ? 'status-dot-ok' : isUnknown ? 'status-dot-idle' : 'status-dot-warn'
  const version = (health?.version as string | undefined) ?? (health?.api_version as string | undefined)

  const roleLabels: Record<string, string> = {
    talk: 'речь',
    brain: 'мозг',
    memory: 'память',
    vision: 'зрение',
  }

  return (
    <div className="page-content stack">
      <div className="page-header" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem' }}>
        <div>
          <h1 className="page-title">Дашборд</h1>
          <p className="page-sub">Состояние ядра, памяти и баланс LLM</p>
        </div>
        <Button disabled={loading} onClick={() => void load()} type="button" variant="cyan">
          <RefreshCw size={15} style={loading ? { animation: 'spin 1s linear infinite' } : {}} />
          {loading ? 'Обновление…' : 'Обновить'}
        </Button>
      </div>

      {error && <InlineFeedback tone="error">{error}</InlineFeedback>}

      <div style={{ display: 'grid', gap: '1rem', gridTemplateColumns: '280px 1fr' }}>
        <div className="card">
          <div className="card-header">
            <Activity size={15} className="card-icon" />
            <span className="card-title">Состояние</span>
          </div>
          {loading ? (
            <div className="stack-sm"><Skeleton className="h-8" /><Skeleton className="h-6" /><Skeleton className="h-6" /></div>
          ) : (
            <div className="stack-sm">
              <span className={`status-badge ${statusClass}`} style={{ alignSelf: 'flex-start' }}>
                <span className={`status-dot ${dotClass}`} />
                {statusLabel(rawStatus)}
              </span>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.82rem', padding: '0.5rem 0.75rem', background: 'rgba(9,9,15,0.6)', borderRadius: 8, border: '1px solid var(--border)' }}>
                <span style={{ color: 'var(--muted)' }}>Аптайм</span>
                <span style={{ fontFamily: 'var(--mono)', color: 'var(--text)' }}>
                  {formatUptime(health?.uptime_seconds)}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.82rem', padding: '0.5rem 0.75rem', background: 'rgba(9,9,15,0.6)', borderRadius: 8, border: '1px solid var(--border)' }}>
                <span style={{ color: 'var(--muted)' }}>Версия API</span>
                <span style={{ fontFamily: 'var(--mono)', color: 'var(--text)' }}>
                  {fmtNum(version)}
                </span>
              </div>
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-header">
            <Brain size={15} className="card-icon card-icon-cyan" />
            <span className="card-title">Память</span>
          </div>
          {loading ? (
            <div className="grid-3"><Skeleton className="h-20" /><Skeleton className="h-20" /><Skeleton className="h-20" /></div>
          ) : (
            <div className="stack-sm">
              <div className="grid-3">
                {[
                  { label: 'Краткосрочная (STM)', value: memory?.short_memory_size },
                  { label: 'Chroma (RAG)', value: memory?.hub?.chroma_records ?? memory?.long_memory_records },
                  { label: 'Люди (кэш)', value: memory?.people_records },
                ].map(({ label, value }) => (
                  <div key={label} className="stat-tile">
                    <p className="stat-label">{label}</p>
                    <p className="stat-value">{value ?? '—'}</p>
                  </div>
                ))}
              </div>
              {memory?.hub && (
                <div className="grid-3" style={{ marginTop: '0.5rem' }}>
                  {[
                    { label: 'Журнал чата', value: memory.hub.chat_log },
                    { label: 'Люди (SQLite)', value: memory.hub.people },
                    { label: 'Дневник', value: memory.hub.diary_notes },
                    { label: 'Журнал ядра', value: memory.hub.journal_entries },
                    { label: 'Снимки WM', value: memory.hub.working_memory_snapshots },
                    { label: 'Режим RAG', value: memory.hub.rag_write_mode },
                  ].map(({ label, value }) => (
                    <div key={label} className="stat-tile">
                      <p className="stat-label">{label}</p>
                      <p className="stat-value-md">{value ?? '—'}</p>
                    </div>
                  ))}
                </div>
              )}
              {!memory?.hub && (
                <p style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>
                  Статистика Memory Hub появится после ответа ядра на /v1/memory/stats.
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <Wallet size={15} className="card-icon card-icon-pink" />
          <span className="card-title">Баланс LLM</span>
        </div>
        {balance?.roles && (
          <p style={{ fontSize: '0.82rem', color: 'var(--muted)', marginBottom: '0.75rem' }}>
            Роли:{' '}
            <span style={{ fontFamily: 'var(--mono)', color: 'var(--text)' }}>
              {Object.entries(balance.roles)
                .map(([k, v]) => `${roleLabels[k] ?? k}=${v}`)
                .join(' · ') || '—'}
            </span>
          </p>
        )}
        {balance?.hint && <p style={{ fontSize: '0.82rem', color: 'var(--muted)', marginBottom: '0.75rem' }}>{balance.hint}</p>}
        {([
          ['OpenRouter', balance?.openrouter],
          ['AIHope', balance?.aihope],
        ] as const)
          .filter(([, block]) => block != null)
          .map(([name, block]) => (
            <ProviderBalanceBlock key={name} block={block as ProviderBalance} name={name} />
          ))}
        {!balance?.openrouter && !balance?.aihope && (
          <>
            <div className="grid-4">
              {[
                { label: 'Провайдер', value: balance?.provider ?? balance?.default_provider },
                { label: 'Остаток', value: balance?.limit_remaining },
                { label: 'Лимит', value: balance?.limit },
                { label: 'Израсходовано', value: balance?.usage },
              ].map(({ label, value }) => (
                <div key={label} className="stat-tile">
                  <p className="stat-label">{label}</p>
                  <p className="stat-value-md">{fmtBalanceValue(value)}</p>
                </div>
              ))}
            </div>
            <p style={{ marginTop: '0.75rem', fontSize: '0.8rem', color: 'var(--muted)' }}>
              День / неделя / месяц:{' '}
              <span style={{ fontFamily: 'var(--mono)', color: 'var(--text)' }}>
                {fmtBalanceValue(balance?.usage_daily)} / {fmtBalanceValue(balance?.usage_weekly)} /{' '}
                {fmtBalanceValue(balance?.usage_monthly)}
              </span>
            </p>
          </>
        )}
      </div>

      <div className="card">
        <div className="card-header">
          <Brain size={15} className="card-icon" />
          <span className="card-title">Обслуживание долгосрочной памяти</span>
        </div>
        <p style={{ fontSize: '0.8rem', color: 'var(--muted)', marginBottom: '1rem' }}>
          Нужна роль maint или admin.
        </p>
        <div className="row" style={{ marginBottom: '0.75rem', alignItems: 'flex-end' }}>
          <label className="label" style={{ minWidth: 180 }}>
            <span className="label-text">Очистка: старше (дней)</span>
            <input className="input input-mono" onChange={(e) => setPruneDays(e.target.value)} style={{ width: 120 }} type="text" value={pruneDays} />
          </label>
          <label className="label" style={{ minWidth: 200 }}>
            <span className="label-text">Суммаризация: старше (дней)</span>
            <input className="input input-mono" onChange={(e) => setSumDays(e.target.value)} style={{ width: 120 }} type="text" value={sumDays} />
          </label>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.85rem', color: 'var(--muted)', marginBottom: '0.85rem', cursor: 'pointer' }}>
          <input checked={sumCompress} onChange={(e) => setSumCompress(e.target.checked)} type="checkbox" />
          Суммаризация со сжатием через LLM (digest в RAG)
        </label>
        <div className="row">
          <Button disabled={ltmBusy} onClick={() => void runLtm('/v1/memory/prune', { older_than_days: Number(pruneDays) || 90, dry_run: true })} type="button" variant="secondary">Очистка (пробный запуск)</Button>
          <Button disabled={ltmBusy} onClick={() => void runLtm('/v1/memory/prune', { older_than_days: Number(pruneDays) || 90, dry_run: false })} type="button" variant="warn">Очистка</Button>
          <Button disabled={ltmBusy} onClick={() => void runLtm('/v1/memory/summarize', { older_than_days: Number(sumDays) || 60, dry_run: true, max_entries: 500, compress_with_llm: sumCompress })} type="button" variant="secondary">Суммаризация (пробный запуск)</Button>
          <Button disabled={ltmBusy} onClick={() => void runLtm('/v1/memory/summarize', { older_than_days: Number(sumDays) || 60, dry_run: false, max_entries: 500, compress_with_llm: sumCompress })} type="button" variant="cyan">Суммаризация</Button>
        </div>
        {ltmMsg && <pre className="code-block" style={{ marginTop: '0.85rem', maxHeight: 200, overflow: 'auto' }}>{ltmMsg}</pre>}
        {memPolicies && (
          <div style={{ marginTop: '0.85rem', background: 'rgba(5,5,10,0.7)', border: '1px solid var(--border)', borderRadius: 10, padding: '0.75rem 1rem', fontSize: '0.78rem', color: 'var(--muted)' }}>
            <p style={{ fontFamily: 'var(--mono)', color: 'var(--purple)', marginBottom: '0.6rem', fontSize: '0.72rem', letterSpacing: '0.06em', textTransform: 'uppercase' }}>Политики памяти</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.3rem 1rem' }}>
              <span style={{ color: '#6060a0' }}>архив</span><span style={{ fontFamily: 'var(--mono)', color: '#9090b0' }}>{memPolicies.ltm_archive_dir ?? '—'}</span>
              <span style={{ color: '#6060a0' }}>эмбеддинг</span><span style={{ fontFamily: 'var(--mono)', color: '#9090b0' }}>{memPolicies.embedding_model ?? '—'}</span>
              <span style={{ color: '#6060a0' }}>автоочистка</span><span style={{ fontFamily: 'var(--mono)', color: '#9090b0', wordBreak: 'break-all' }}>{JSON.stringify(memPolicies.ltm_auto_prune ?? {})}</span>
              <span style={{ color: '#6060a0' }}>автосумм.</span><span style={{ fontFamily: 'var(--mono)', color: '#9090b0', wordBreak: 'break-all' }}>{JSON.stringify(memPolicies.ltm_auto_summarize ?? {})}</span>
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-header">
          <Database size={15} className="card-icon card-icon-cyan" />
          <span className="card-title">Плагины (обзор)</span>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                {['ID', 'Версия', 'Жизненный цикл', 'Статус', 'Скрипт'].map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {plugins.length === 0 ? (
                <tr><td colSpan={5}>
                  <EmptyState
                    icon={Database}
                    title="Нет данных по плагинам"
                    description="Проверь запуск ядра и /v1/plugins"
                    action={<a className="btn btn-secondary btn-sm" href="/api-docs">Документация</a>}
                  />
                </td></tr>
              ) : plugins.map((row) => (
                <tr key={row.id}>
                  <td><span style={{ fontFamily: 'var(--mono)', fontSize: '0.8rem' }}>{row.id}</span></td>
                  <td>{row.version}</td>
                  <td>{row.lifecycle}</td>
                  <td>
                    <span className={`status-badge ${row.enabled ? 'status-ok' : 'status-idle'}`} style={{ padding: '0.2rem 0.6rem', fontSize: '0.75rem' }}>
                      <span className={`status-dot ${row.enabled ? 'status-dot-ok' : 'status-dot-idle'}`} />
                      {row.enabled ? 'вкл.' : 'выкл.'}
                    </span>
                  </td>
                  <td style={{ fontFamily: 'var(--mono)', fontSize: '0.75rem', wordBreak: 'break-all' }}>{row.main_script || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
