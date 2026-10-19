import { useEffect, useId, useRef, useState } from 'react'
import { apiGet, apiPost, type ApiEnvelope } from '../api'
import { Button } from './ui/button'
import { DangerConfirmDialog } from './ui/danger-confirm-dialog'
import { InlineFeedback } from './ui/inline-feedback'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { Skeleton } from './ui/skeleton'

type Person = { id?: string; display_name?: string; names?: string[]; aliases?: string[] }
type Relation = {
  person_id: string; affinity: number; trust: number; familiarity: number
  tone_bias: string; observed: boolean; history: { event: string; at: string }[]
}
type State = {
  mood: { valence: number; arousal: number; label: string; updated_at: string | null }
  relation: Relation | null; as_of: string; enabled?: { mood: boolean; relations: boolean }
}
type Reset = { scope: 'mood' | 'relations'; person_id?: string; label: string }
const labels: Record<string, string> = { calm: 'Спокойная', warm: 'Тёплое', irritated: 'Раздражённая', cold: 'Сдержанное', neutral: 'Нейтральное' }
const name = (p: Person) => p.display_name || p.names?.[0] || p.aliases?.[0] || p.id || 'Без имени'

export function AffectPanel({ people }: { people: Person[] }) {
  const [personId, setPersonId] = useState('none')
  const [state, setState] = useState<State | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [revision, setRevision] = useState(0)
  const [loadedRevision, setLoadedRevision] = useState(-1)
  const [reset, setReset] = useState<Reset | null>(null)
  const [resetError, setResetError] = useState('')
  const [busy, setBusy] = useState(false)
  const selectId = useId()
  const returnFocusRef = useRef<HTMLButtonElement | null>(null)
  const refreshRef = useRef<HTMLButtonElement | null>(null)
  const restoreAfterLoad = useRef(false)
  // A removed person must never leave another person's scores under the old label.
  const selected = people.find((p) => `person:${p.id}` === personId)
  const effectiveId = selected?.id || ''

  const visibleState = state && (state.relation?.person_id || '') === effectiveId ? state : null

  useEffect(() => {
    let active = true
    setLoading(true)
    setState(null)
    setError('')
    const suffix = effectiveId ? `?person_id=${encodeURIComponent(effectiveId)}` : ''
    void apiGet<ApiEnvelope<State>>(`/v1/memory/affect${suffix}`).then((response) => {
      if (active) setState(response.data)
    }).catch((e: unknown) => {
      if (active) setError(e instanceof Error ? e.message : String(e))
    }).finally(() => {
      if (active) { setLoadedRevision(revision); setLoading(false) }
    })
    return () => { active = false }
  }, [effectiveId, revision])

  useEffect(() => {
    if (!reset && !loading && !busy && loadedRevision === revision && restoreAfterLoad.current) {
      const trigger = returnFocusRef.current
      if (trigger && !trigger.disabled) trigger.focus()
      else refreshRef.current?.focus()
      restoreAfterLoad.current = false
    }
  }, [reset, loading, busy, loadedRevision, revision])

  function ask(next: Reset, trigger: HTMLButtonElement) {
    returnFocusRef.current = trigger
    setResetError('')
    setSuccess('')
    setReset(next)
  }
  async function confirmReset() {
    if (!reset || busy) return
    setBusy(true)
    setResetError('')
    try {
      await apiPost('/v1/memory/affect/reset', { scope: reset.scope, person_id: reset.person_id, confirm: 'WIPE' })
      setSuccess(`${reset.label}: сброшено. Перед сбросом создана резервная копия.`)
      restoreAfterLoad.current = true
      setReset(null)
      setRevision((v) => v + 1)
    } catch (e) {
      setResetError(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }

  return (
    <section className="card stack min-w-0 grid-cols-[minmax(0,1fr)]" aria-label="Настроение и отношения" aria-busy={loading || busy}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold">Настроение и отношения</h2>
        <Button ref={refreshRef} className="min-h-11" variant="outline" disabled={loading || busy} onClick={() => setRevision((v) => v + 1)}>Обновить состояние</Button>
      </div>
      <p className="text-sm text-[var(--muted)]">Это состояние Нейры, а не оценка человека. Явные сигналы диалога меняют его понемногу; со временем оно возвращается к нейтральному. Persona имеет приоритет.</p>
      <div className="flex flex-col gap-2">
        <label htmlFor={selectId} className="text-sm font-medium">Отношение к человеку</label>
        <Select value={selected ? `person:${selected.id}` : 'none'} onValueChange={setPersonId} disabled={busy}>
          <SelectTrigger id={selectId} className="min-h-11" aria-describedby={`${selectId}-hint`}><SelectValue /></SelectTrigger>
          <SelectContent className="max-w-[calc(100vw-2rem)]"><SelectGroup>
            <SelectItem value="none">Только настроение</SelectItem>
            {people.filter((p) => p.id).map((p) => <SelectItem className="break-all whitespace-normal" key={p.id} value={`person:${p.id}`}>{name(p)} · {p.id}</SelectItem>)}
          </SelectGroup></SelectContent>
        </Select>
        <p id={`${selectId}-hint`} className="text-sm text-[var(--muted)]">Люди различаются по ID, даже если имена совпадают.</p>
      </div>
      {state?.enabled?.mood === false && <InlineFeedback tone="info">Настроение выключено в настройках. Ниже — сохранённое состояние.</InlineFeedback>}
      {state?.enabled?.relations === false && <InlineFeedback tone="info">Отношения выключены в настройках. Сохранённые данные не влияют на ответы.</InlineFeedback>}
      {error && <InlineFeedback tone="error">{error}</InlineFeedback>}
      {success && <InlineFeedback tone="success">{success}</InlineFeedback>}
      {loading ? <><p role="status" className="text-sm text-[var(--muted)]">Загрузка состояния…</p><Skeleton className="h-20" /></> : visibleState && <>
        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
          <div><dt className="text-[var(--muted)]">Настроение</dt><dd>{visibleState.mood.label === 'warm' ? 'Доброжелательная' : labels[visibleState.mood.label] || visibleState.mood.label}</dd></div>
          <div><dt className="text-[var(--muted)]">Тон (−1…1)</dt><dd className="tabular-nums">{visibleState.mood.valence.toFixed(2)}</dd></div>
          <div><dt className="text-[var(--muted)]">Активность (0…1)</dt><dd className="tabular-nums">{visibleState.mood.arousal.toFixed(2)}</dd></div>
        </dl>
        {!visibleState.mood.updated_at && <p className="text-sm text-[var(--muted)]">Пока нет завершённых ходов. Настроение нейтральное.</p>}
        {visibleState.relation ? <>
          <h3 className="break-words text-sm font-semibold">{selected ? name(selected) : visibleState.relation.person_id}</h3>
          {visibleState.relation.observed ? <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
            <div><dt className="text-[var(--muted)]">Отношение</dt><dd>{labels[visibleState.relation.tone_bias] || visibleState.relation.tone_bias} · <span className="tabular-nums">{visibleState.relation.affinity.toFixed(2)}</span></dd></div>
            <div><dt className="text-[var(--muted)]">Доверие (0…1)</dt><dd className="tabular-nums">{visibleState.relation.trust.toFixed(2)}</dd></div>
            <div><dt className="text-[var(--muted)]">Знакомство (0…1)</dt><dd className="tabular-nums">{visibleState.relation.familiarity.toFixed(2)}</dd></div>
          </dl> : <p className="text-sm text-[var(--muted)]">Отношения пока не сформированы. Нет сохранённых взаимодействий.</p>}
          <p className="text-sm text-[var(--muted)]">Доверие меняется только по явному признанию лжи и со временем возвращается к 0.50. Это субъективное состояние, а не проверка фактов.</p>
        </> : <p className="text-sm text-[var(--muted)]">Выберите человека, чтобы посмотреть отношения.{people.length === 0 ? ' Список людей пока пуст.' : ''}</p>}
      </>}
      <div className="flex flex-wrap gap-3">
        <Button className="min-h-11" variant="outline" disabled={loading || busy || !visibleState} onClick={(event) => ask({ scope: 'mood', label: 'Настроение Нейры' }, event.currentTarget)}>Сбросить настроение</Button>
        <Button className="min-h-11" variant="outline" disabled={loading || busy || !visibleState?.relation || !selected} onClick={(event) => ask({ scope: 'relations', person_id: selected?.id, label: `Отношение к ${selected ? name(selected) : ''}` }, event.currentTarget)}>Сбросить выбранное отношение</Button>
        <Button className="min-h-11" variant="outline" disabled={loading || busy || !visibleState} onClick={(event) => ask({ scope: 'relations', label: 'Все отношения' }, event.currentTarget)}>Сбросить все отношения</Button>
      </div>
      <DangerConfirmDialog open={Boolean(reset)} title="Сбросить состояние?"
        description={`${reset?.label || ''}. Будет создана резервная копия. Дневник, факты и история чата сохранятся.${resetError ? ` Ошибка: ${resetError}` : ''}`}
        confirmPhrase="СБРОСИТЬ" confirmLabel="Сбросить" busy={busy}
        returnFocusRef={returnFocusRef}
        onCancel={() => { restoreAfterLoad.current = true; setReset(null) }} onConfirm={() => { void confirmReset() }} />
    </section>
  )
}
