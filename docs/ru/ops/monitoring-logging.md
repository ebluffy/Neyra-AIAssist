<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Соавторство: материал создан при поддержке ИИ-агента [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# Мониторинг и логи

- Health monitor: `server/core/health_monitor.py`.
- Статус-отчёты: `server/logs/health_status.jsonl` (или путь из `server/config/runtime.yaml` / ключей logging в корневом конфиге).
- Системные логи: путь из `logging.system_log` (default под `server/logs/`).
- Диалоговые логи: путь из `logging.chat_log`.

Для алертов в интеграции используйте webhook routes и отслеживайте `deliveries` / `dlq`.
