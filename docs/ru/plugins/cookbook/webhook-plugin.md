<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Соавторство: материал создан при поддержке ИИ-агента [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# Cookbook: Webhook Plugin

## Цель
Принимать входящие webhook события и отправлять их в `agent.chat` или event bus.

## Шаблон
- `plugin.yaml`: `lifecycle: resident` или `on_demand`.
- `config.yaml`: endpoint path, provider mode, signing secret name.
- `main.py`: валидация запроса, нормализация payload, публикация `CoreEvent`.

## Практика
Для HTTP endpoint-ов предпочитайте реализацию внутри `server/core/api/api_server.py`, а плагин используйте для бизнес-обработки событий.