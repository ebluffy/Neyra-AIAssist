import { FileQuestion } from 'lucide-react'
import { Link } from 'react-router-dom'
import { PageHeader } from '../components/ui/page-header'

export function NotFoundScreen() {
  return (
    <div className="page-content stack">
      <PageHeader title="Не найдено" subtitle="Такой страницы нет" />
      <div className="empty-state">
        <div className="empty-state-icon" aria-hidden>
          <FileQuestion size={22} strokeWidth={1.75} />
        </div>
        <p className="empty-state-title">404</p>
        <p className="empty-state-desc">Проверьте адрес или вернитесь на статус.</p>
        <Link className="btn btn-secondary" to="/status">
          К статусу
        </Link>
      </div>
    </div>
  )
}
