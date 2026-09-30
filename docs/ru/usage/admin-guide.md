<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Соавторство: материал создан при поддержке ИИ-агента [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# Гайд администратора

## Базовые действия
- Проверять `GET /v1/health`.
- Просматривать логи в `server/logs/`.
- Делать backup через `POST /v1/backup/run`.

## Управление плагинами
- Вкл/выкл: `PATCH /v1/plugins/{id}`.
- Конфиг плагина: `PUT /v1/plugins/{id}/config`.
- Для resident-плагинов изменения lifecycle применяются через перезапуск процесса.

## Webhooks
- Создавайте outbound routes в `/v1/webhooks/out/routes`.
- Отслеживайте доставки `/v1/webhooks/deliveries` и DLQ `/v1/webhooks/dlq`.