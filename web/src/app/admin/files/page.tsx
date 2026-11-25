import { Card, PageHeader, StatusPill } from '../../../components/admin/ui';

export const dynamic = 'force-dynamic';

export default function AdminFilesPage() {
  return (
    <div className="space-y-4">
      <PageHeader
        title="Файлы и вложения"
        description="Вложения волны 2: ядро принимает файлы и отдаёт их по id, но списка всех файлов у него пока нет."
      />
      <Card title="Состояние" description="Пустая таблица здесь означала бы «файлов нет» — это было бы неправдой.">
        <div className="flex items-center gap-3">
          <StatusPill tone="warn">нет API списка</StatusPill>
          <p className="text-sm text-[var(--muted)]">Ядро не умеет перечислять вложения: файл адресуется парой id + канал.</p>
        </div>
        <p className="mt-3 text-xs text-[var(--muted)]">
          Список с размером, владельцем и удалением включим, когда в ядре появится API перечисления.
          Удаление файлов сейчас недоступно и не имитируется.
        </p>
      </Card>
    </div>
  );
}
