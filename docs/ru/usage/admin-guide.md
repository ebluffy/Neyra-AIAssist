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