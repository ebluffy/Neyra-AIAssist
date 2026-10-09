import { toast } from 'sonner'
import { Button } from '../components/ui/button'
import { DangerConfirmDialog } from '../components/ui/danger-confirm-dialog'
import { EmptyState } from '../components/ui/empty-state'
import { ErrorState } from '../components/ui/error-state'
import { InlineFeedback } from '../components/ui/inline-feedback'
import { PageHeader } from '../components/ui/page-header'
import { ApiRequestError } from '../api'
import { useState } from 'react'
import { Box } from 'lucide-react'

/** Dev-only UI kit at /__ui */
export function UiKitScreen() {
  const [dangerOpen, setDangerOpen] = useState(false)

  return (
    <div className="page-content stack">
      <PageHeader title="UI kit" subtitle="Только в DEV · /__ui" />

      <div className="card stack-sm">
        <div className="card-header">
          <span className="card-title">Кнопки</span>
        </div>
        <div className="row">
          <Button type="button">Primary</Button>
          <Button type="button" variant="secondary">
            Secondary
          </Button>
          <Button type="button" variant="danger">
            Danger
          </Button>
          <Button type="button" variant="cyan">
            Cyan
          </Button>
          <Button onClick={() => toast.success('Сохранено')} type="button" variant="secondary">
            Toast
          </Button>
          <Button onClick={() => setDangerOpen(true)} type="button" variant="danger">
            Danger dialog
          </Button>
        </div>
      </div>

      <div className="card">
        <InlineFeedback message="Инфо-баннер" tone="info" />
      </div>

      <div className="card">
        <ErrorState
          error={new ApiRequestError('Пример ошибки', 500, 'internal', 'trace-dev-001')}
          onRetry={() => toast.message('Retry')}
        />
      </div>

      <div className="card">
        <EmptyState description="Нет данных" icon={Box} title="Пусто" />
      </div>

      <DangerConfirmDialog
        confirmPhrase="УДАЛИТЬ"
        description="Демо type-to-confirm."
        onCancel={() => setDangerOpen(false)}
        onConfirm={() => {
          setDangerOpen(false)
          toast.success('Подтверждено')
        }}
        open={dangerOpen}
        title="Опасное действие"
      />
    </div>
  )
}
