import { FileQuestion } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Button } from '../components/ui/button'
import { PageHeader } from '../components/ui/page-header'

export function NotFoundScreen() {
  return (
    <div className="page-content stack page-enter">
      <PageHeader title="Страница не найдена" subtitle="Маршрут не существует" />
      <div className="empty-state">
        <div className="empty-state-icon" aria-hidden>
          <FileQuestion size={22} strokeWidth={1.75} />
        </div>
        <p className="empty-state-title">404</p>
        <p className="empty-state-desc">Проверьте адрес или откройте командную палитру.</p>
        <div className="row" style={{ justifyContent: 'center', gap: '0.6rem' }}>
          <Button asChild variant="secondary">
            <Link to="/status">На статус</Link>
          </Button>
          <Button
            onClick={() => window.dispatchEvent(new Event('neyra:open-command-palette'))}
            type="button"
            variant="ghost"
          >
            Открыть ⌘K
          </Button>
        </div>
      </div>
    </div>
  )
}
