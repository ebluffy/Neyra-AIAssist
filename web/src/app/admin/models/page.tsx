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
          <div className="overflow-x-auto">
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
                    <tr key={lane}>
                      <td className={tdClass}>
                        <span className="block text-sm">{laneLabel[lane]}</span>
                        <span className="text-xs text-[var(--muted)]">{lane}</span>
                      </td>
                      <td className={tdClass}>{row?.provider ?? '—'}</td>
                      <td className={`${tdClass} font-mono text-xs`}>{row?.model ?? '—'}</td>
                      <td className={tdClass}><StatusPill tone="muted">только чтение</StatusPill></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-[var(--muted)]">
            Температура, max tokens, таймауты, лимит контекста и порог автосжатия ядро через API пока не отдаёт —
            панель их не рисует, чтобы не показывать выдуманные значения.
          </p>
        </Card>
      )}
    </div>
  );
}
