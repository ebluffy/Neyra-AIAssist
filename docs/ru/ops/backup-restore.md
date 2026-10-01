# Бэкап и восстановление

- Запуск: `POST /v1/backup/run` (admin token).
- Артефакты и расписания: `server/config/memory.yaml` (`backup`, `external_storage`).
- В операционные бэкапы включайте `server/data/memory/`, `server/config.yaml`, `server/config/` и `server/.env` (`.env` не коммитить).

## Рекомендации

- Делать регулярные snapshot перед обновлениями.
- Проверять восстановление на отдельной копии данных.
