import { Card, PageHeader, StatusPill } from '../../../components/admin/ui';

export const dynamic = 'force-dynamic';

export default function AdminPromptsPage() {
  return (
    <div className="space-y-4">
      <PageHeader
        title="Промпты и персона"
        description="Персона и системные промпты живут в конфиге ядра. Панель не читает файлы ядра напрямую."
      />
      <Card title="Состояние" description="Раздел ждёт API чтения и записи в ядре.">
        <div className="flex items-center gap-3">
          <StatusPill tone="warn">нет API ядра</StatusPill>
          <p className="text-sm text-[var(--muted)]">Ядро пока не отдаёт персону и системные промпты через API.</p>
        </div>
        <p className="mt-3 text-xs text-[var(--muted)]">
          Когда в ядре появится API чтения, здесь будет текущий текст, а история изменений — из журнала аудита.
          Прямое чтение файлов ядра с сайта не делаем: это обошло бы его права и версионирование.
        </p>
      </Card>
    </div>
  );
}
