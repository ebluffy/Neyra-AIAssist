import { useQuery } from '@tanstack/react-query'
import { Activity } from 'lucide-react'
import { apiGet } from '../api'
import type { ApiEnvelope } from '../api'
import { EmptyState } from './ui/empty-state'
import { ErrorState } from './ui/error-state'
import { Skeleton } from './ui/skeleton'

export type ModelCall = {
  lane: string; purpose: string; attempt: number; status: string
  provider: string | null; configured_model: string | null; reported_model: string | null
  has_images: boolean
  provider_request_id?: string | null; duration_ms?: number | null; first_meaningful_token_ms?: number | null
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_tokens?: number } | null
}
export type ModelTurn = {
  turn_id: string; timestamp: string; status: string; without_llm: boolean; calls: ModelCall[]
  kind?: string; parent_turn_id?: string | null
}

const labels: Record<string, string> = {
  completed: 'Завершён', failed: 'Ошибка', cancelled: 'Отменён', running: 'Выполняется',
  talk: 'Речь', brain: 'Мозг', vision: 'Зрение', memory: 'Память', coder: 'Код',
  turn_diary: 'Дневник хода', working_memory: 'Рабочая память', nightly_reflection: 'Рефлексия',
  reply: 'Ответ', stream_reply: 'Потоковый ответ', rewrite: 'Перефразирование',
  routing: 'Маршрутизация', tools: 'Инструменты', summary: 'Итог', caption: 'Описание изображения',
  empty_reply_retry: 'Повтор пустого ответа', persona_warmup: 'Прогрев persona',
}

export function ModelActivity({ polling }: { polling: boolean }) {
  const query = useQuery({
    queryKey: ['status', 'model-activity'],
    queryFn: async () => (await apiGet<ApiEnvelope<{ items: ModelTurn[] }>>('/v1/llm/activity?limit=10')).data,
    refetchInterval: polling ? 15_000 : false,
    retry: false,
  })
  return (
    <section aria-labelledby="model-activity-title" className="card">
      <div className="card-header"><h2 className="card-title" id="model-activity-title">Последние вызовы</h2></div>
      <p className="hint">Модели из ответов провайдеров. Настройка сама по себе не подтверждает использованную модель.</p>
      {query.isLoading ? <Skeleton className="h-16" /> : query.error ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : !query.data?.items?.length ? (
        <EmptyState icon={Activity} title="Вызовов пока нет" description="Отчёты появятся после диалога. История очищается при перезапуске ядра." />
      ) : <div className="stack-sm">
        {query.data.items.map((turn) => <details key={turn.turn_id} open={turn === (query.data.items.find((item) => item.kind !== 'background') ?? query.data.items[0])}>
          <summary className="cursor-pointer py-3 text-sm">
            <time dateTime={turn.timestamp}>{new Date(turn.timestamp).toLocaleTimeString('ru-RU')}</time>
            {turn.kind === 'background' && ' · Фоновая задача'}
            {' · '}{labels[turn.status] ?? turn.status}{turn.without_llm && ' · Без вызова LLM'}
          </summary>
          {turn.calls.map((call, i) => <div className="stack-sm rounded-md border border-border p-3" key={i}>
            <p className="text-sm">{labels[call.lane] ?? call.lane} · {labels[call.purpose] ?? call.purpose} · {labels[call.status] ?? call.status} · попытка {call.attempt}{call.has_images && ' · изображение'}</p>
            <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
              <div><dt className="hint">Провайдер</dt><dd className="break-all">{call.provider ?? 'Неизвестен'}</dd></div>
              <div><dt className="hint">Настроено</dt><dd className="break-all font-mono">{call.configured_model ?? 'Неизвестно'}</dd></div>
              <div><dt className="hint">Сообщено провайдером</dt><dd className="break-all font-mono">{call.reported_model ?? 'Не сообщена'}</dd></div>
              <div><dt className="hint">ID запроса провайдера</dt><dd className="break-all font-mono">{call.provider_request_id ?? 'Не сообщён'}</dd></div>
              <div><dt className="hint">Длительность / первый текст</dt><dd>{call.duration_ms == null ? 'Не измерена' : `${(call.duration_ms / 1000).toFixed(2)} с`} / {call.first_meaningful_token_ms == null ? 'Не измерен' : `${(call.first_meaningful_token_ms / 1000).toFixed(2)} с`}</dd></div>
              <div><dt className="hint">Токены: вход / выход / кэш</dt><dd>{call.usage?.input_tokens ?? 'Не сообщено'} / {call.usage?.output_tokens ?? 'Не сообщено'} / {call.usage?.cache_read_tokens ?? 'Не сообщено'}</dd></div>
            </dl>
          </div>)}
        </details>)}
      </div>}
    </section>
  )
}
