import { readAdminConfig } from '../../../../lib/admin-config';
import { ModelsForm } from '../../../components/admin/models-form';
import { Card, EmptyState, PageHeader, StatusPill } from '../../../components/admin/ui';

export const dynamic = 'force-dynamic';

export default async function AdminModelsPage() {
  const result = await readAdminConfig();
  const config = result.state === 'ok' ? result.data : null;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Модели"
        description="Провайдер, модель и лимиты по лейнам. Сохранение идёт в конфиг ядра; лейны применяются сразу, память — после рестарта."
      />

      {!config ? (
        <EmptyState
          title="Ядро не отдало конфиг"
          text={result.message ?? 'Проверьте NEYRA_API_URL и NEYRA_SERVICE_KEY в .env сайта.'}
        />
      ) : (
        <Card
          title="Лейны"
          description="Источник: GET /v1/config ядра. Пустое поле означает «не задано», а не ноль."
          footer={<span className="flex items-center gap-2"><StatusPill tone="ok">запись включена</StatusPill>Каждое изменение пишется в журнал ядра и сайта.</span>}
        >
          <ModelsForm lanes={config.lanes} providers={config.providers} />
        </Card>
      )}
    </div>
  );
}
