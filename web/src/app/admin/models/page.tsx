import { coreGet, type CoreModelRoles } from '../../../../lib/core-admin';
import { Card, EmptyState, PageHeader, StatusPill, tableClass, tdClass, thClass } from '../../../components/admin/ui';

export const dynamic = 'force-dynamic';

const lanes = ['talk', 'brain', 'memory', 'vision'] as const;
const laneLabel: Record<string, string> = {
  talk: 'Разговор',
  brain: 'Рассуждение',
  memory: 'Память',
  vision: 'Зрение',
};

export default async function AdminModelsPage() {
  const result = await coreGet<CoreModelRoles>('/v1/llm/models', { timeoutMs: 4000 });
  const roles = result.state === 'ok' ? result.data?.roles ?? {} : {};

  return (
    <div className="space-y-4">
      <PageHeader
        title="Модели"
        description="Провайдер и модель по лейнам — как их видит ядро. Запись параметров включим, когда у ядра появится API настроек."
      />

      {result.state !== 'ok' ? (
        <EmptyState
          title="Ядро не отдало модели"
          text={result.message ?? 'Проверьте NEYRA_API_URL и NEYRA_SERVICE_KEY в .env сайта.'}
        />
      ) : (
        <Card title="Лейны" description="Источник: GET /v1/llm/models ядра.">
          {/* Desktop table view */}
          <div className="hidden sm:block overflow-x-auto">
            <table className={tableClass}>
              <thead>
                <tr>
                  <th className={thClass}>Лейн</th>
                  <th className={thClass}>Провайдер</th>
                  <th className={thClass}>Модель</th>
                  <th className={thClass}>Запись</th>
                </tr>
              </thead>
              <tbody>
                {lanes.map(lane => {
                  const row = roles[lane];
                  return (
                    <tr key={lane} className="hover:bg-[var(--surface-2)]">
                      <td className={tdClass}>
                        <span className="block text-sm font-medium text-[var(--text)]">{laneLabel[lane]}</span>
                        <span className="text-xs text-[var(--text-subtle)] font-mono">{lane}</span>
                      </td>
                      <td className={tdClass}>{row?.provider ?? '—'}</td>
                      <td className={`${tdClass} font-mono text-xs break-all max-w-[280px]`}>{row?.model ?? '—'}</td>
                      <td className={tdClass}><StatusPill tone="muted">только чтение</StatusPill></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile card view (prevent truncation on 390px) */}
          <div className="sm:hidden space-y-2.5">
            {lanes.map(lane => {
              const row = roles[lane];
              return (
                <div key={lane} className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] p-3 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-sm text-[var(--text)]">{laneLabel[lane]}</span>
                    <span className="font-mono text-xs text-[var(--text-subtle)]">{lane}</span>
                  </div>
                  <div className="text-xs text-[var(--text-muted)] flex justify-between">
                    <span>Провайдер:</span>
                    <span className="font-medium text-[var(--text)]">{row?.provider ?? '—'}</span>
                  </div>
                  <div className="text-xs text-[var(--text-muted)] space-y-0.5">
                    <span>Модель:</span>
                    <div className="font-mono text-[11px] text-[var(--text)] break-all bg-[var(--surface-3)] p-1.5 rounded border border-[var(--border)]">
                      {row?.model ?? '—'}
                    </div>
                  </div>
                  <div className="pt-1 flex justify-end">
                    <StatusPill tone="muted">только чтение</StatusPill>
                  </div>
                </div>
              );
            })}
          </div>

          <p className="mt-3 text-xs text-[var(--text-subtle)] leading-relaxed">
            Температура, max tokens, таймауты, лимит контекста и порог автосжатия ядро через API пока не отдаёт —
            панель их не рисует, чтобы не показывать выдуманные значения.
          </p>
        </Card>
      )}
    </div>
  );
}
