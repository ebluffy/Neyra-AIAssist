<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Соавторство: материал создан при поддержке ИИ-агента [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# Бэкап и восстановление

- Запуск: `POST /v1/backup/run` (admin token).
- Артефакты и расписания: `server/config/memory.yaml` (`backup`, `external_storage`).
- В операционные бэкапы включайте `server/data/memory/`, `server/config.yaml`, `server/config/` и `server/.env` (`.env` не коммитить).

## Рекомендации

- Делать регулярные snapshot перед обновлениями.
- Проверять восстановление на отдельной копии данных.
