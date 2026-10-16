import { useCallback, useEffect, useRef, useState } from 'react'
import { apiGet, apiPost, type ApiEnvelope } from '../api'
import { Button } from './ui/button'
import { InlineFeedback } from './ui/inline-feedback'

type SessionStatus = {
  enabled: boolean
  warmup_state: 'idle' | 'warming' | 'ready' | 'failed' | 'disabled'
  active_sessions: number
  warmed_at: string | null
}
const LABELS = {
  idle: 'Persona ещё не прогрета. Первый диалог отправит её сам.',
  warming: 'Прогрев persona выполняется…',
  ready: 'Заготовка persona готова. Лички и общие каналы используют свои цепочки.',
  failed: 'Прогрев не удался. Первый диалог попробует создать свою цепочку.',
  disabled: 'Responses выключены. Используется обычный чат.',
}

export function TalkSessionStatus({ settingsDirty }: { settingsDirty: boolean }) {
  const [data, setData] = useState<SessionStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const sequence = useRef(0)
  const load = useCallback(async (signal?: AbortSignal) => {
    const request = ++sequence.current
    try {
      const result = await apiGet<ApiEnvelope<SessionStatus>>('/v1/llm/sessions', signal)
      if (!signal?.aborted && request === sequence.current) { setData(result.data); setError('') }
    } catch {
      if (!signal?.aborted && request === sequence.current) setError('Не удалось получить состояние сессий. Обновите данные.')
    }
  }, [])
  const invalidate = useCallback(() => { sequence.current++ }, [])
  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => { controller.abort(); invalidate() }
  }, [load, settingsDirty, invalidate])
  useEffect(() => {
    if (data?.warmup_state !== 'warming') return
    const controller = new AbortController()
    const timer = window.setTimeout(() => void load(controller.signal), 3000)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [data, load])
  async function warmup() {
    const request = ++sequence.current
    setBusy(true)
    setError('')
    try {
      const result = await apiPost<ApiEnvelope<SessionStatus>>('/v1/llm/sessions/warmup', {})
      if (request === sequence.current) setData(result.data)
    } catch { if (request === sequence.current) setError('Не удалось начать прогрев. Проверьте сохранённые настройки и доступ к API.') }
    finally { setBusy(false) }
  }
  return (
    <section aria-label="Состояние сессий речи" aria-busy={busy} className="stack min-w-0">
      <p className="text-sm text-muted-foreground" role="status" aria-live="polite">
        {data ? LABELS[data.warmup_state] : 'Загрузка состояния сессий…'}
        {data?.enabled && <> Активных диалогов: {data.active_sessions}.</>}
      </p>
      <div className="row flex-wrap">
        <Button type="button" variant="secondary" onClick={() => void load()}>Обновить сессии</Button>
        <Button type="button" variant="secondary" disabled={busy || !data?.enabled || data.warmup_state === 'warming' || settingsDirty} onClick={() => void warmup()} aria-describedby="warmup-cost">
          {busy ? 'Запуск прогрева…' : 'Прогреть persona'}
        </Button>
      </div>
      <p id="warmup-cost" className="text-sm text-muted-foreground">
        Прогрев — платный запрос к модели речи. Повторный прогрев сбросит цепочки диалогов у провайдера; локальная память сохранится.
        {settingsDirty && ' Сначала сохраните или отмените изменения настроек.'}
      </p>
      {error && <InlineFeedback tone="error">{error}</InlineFeedback>}
    </section>
  )
}
