import { Blocks, Bot, Cable, ShieldCheck } from 'lucide-react'

export function HomePage() {
  return (
    <div className="page-content stack">
      <div className="page-header">
        <h1 className="page-title">Нейра · Микро-сайт</h1>
        <p className="page-sub">Единая панель управления AI-ядром</p>
      </div>

      <div className="card card-glow">
        <div className="card-header">
          <Bot size={16} className="card-icon" />
          <span className="card-title">О системе</span>
        </div>
        <p style={{ fontSize: '0.9rem', color: 'var(--muted)', lineHeight: 1.7, marginBottom: '1.25rem' }}>
          Это единая панель управления: состояние ядра, API, плагины, вебхуки и эксплуатационная документация.
          Все компоненты работают через локальный Neyra API.
        </p>

        <div className="grid-2">
          <div className="stat-tile">
            <p className="stat-label" style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: '0.75rem' }}>
              <Blocks size={13} style={{ color: 'var(--purple)' }} />
              Основные разделы
            </p>
            <ul style={{ listStyle: 'none', display: 'grid', gap: '0.4rem' }}>
              {[
                'Дашборд: здоровье ядра, память, баланс модели.',
                'Плагины: включение/выключение, конфиг, invoke.',
                'Вебхуки: маршруты и доставки/DLQ.',
                'API Docs: Swagger + OpenAPI JSON + Markdown.',
              ].map((t) => (
                <li key={t} style={{ fontSize: '0.82rem', color: '#9090b0', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <span style={{ color: 'var(--purple)', marginTop: 2 }}>›</span> {t}
                </li>
              ))}
            </ul>
          </div>

          <div className="stat-tile">
            <p className="stat-label" style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: '0.75rem' }}>
              <ShieldCheck size={13} style={{ color: 'var(--pink)' }} />
              Техническая информация
            </p>
            <p style={{ fontSize: '0.82rem', color: '#9090b0', lineHeight: 1.65 }}>
              Neyra API поднимается вместе с{' '}
              <span className="inline-code">python main.py</span> и использует конфиг{' '}
              <span className="inline-code">server/config/server.yaml</span> (<span className="inline-code">api:</span>).
            </p>
            <p style={{ marginTop: '0.75rem', fontSize: '0.75rem', color: 'var(--muted)', display: 'flex', gap: 6, alignItems: 'center' }}>
              <Cable size={13} />
              Рассчитана на локальную эксплуатацию.
            </p>
          </div>
        </div>
      </div>

      {/* Quick stats */}
      <div className="grid-3">
        {[
          { label: 'API Версия', value: 'v1',    sub: 'core.api',           color: 'var(--purple)' },
          { label: 'Интерфейс', value: 'Local',  sub: 'localhost:8787',     color: 'var(--cyan)' },
          { label: 'Статус',    value: 'Ready',  sub: 'Сервер запущен',     color: 'var(--emerald)' },
        ].map(({ label, value, sub, color }) => (
          <div key={label} className="stat-tile" style={{ textAlign: 'center', borderTop: `2px solid ${color}`, paddingTop: '1.25rem' }}>
            <p className="stat-label">{label}</p>
            <p className="stat-value" style={{ fontSize: '1.5rem', color, margin: '0.35rem 0 0.3rem' }}>{value}</p>
            <p style={{ fontSize: '0.72rem', color: 'var(--muted)' }}>{sub}</p>
          </div>
        ))}
      </div>
    </div>
  )
}
