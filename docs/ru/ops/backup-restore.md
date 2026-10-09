# Бэкап и восстановление

- Запуск: `POST /v1/backup/run` (admin token).
- Артефакты и расписания: `server/config/memory.yaml` (`backup`, `external_storage`).
- В операционные бэкапы включайте `server/data/memory/`, `server/config.yaml`, `server/config/` и `server/.env` (`.env` не коммитить).

## Pending restore / rollback_failed

Restore кладёт staging в `.neyra_pending_restore/` и применяет при следующем старте ядра. Если откат живой памяти (или внешней sqlite) не удался — статус `rollback_failed`, процесс выходит, `blocked.json` блокирует pending, чтобы автоперезапуск не повторил apply. Вручную: вернуть `*.pre-restore-*` (см. `aside_path` в `blocked.json` / `last_restore_apply.json`) на живой путь при необходимости, затем удалить `.neyra_pending_restore/` (или хотя бы `blocked.json` + staging) и только потом стартовать снова.

## Рекомендации

- Делать регулярные snapshot перед обновлениями.
- Проверять восстановление на отдельной копии данных.
