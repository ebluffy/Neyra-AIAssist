# REST Endpoints

## Breaking changes (API 1.1.0)

- Env: `INTERNAL_API_*` → `API_*` (старт падает, если старые имена заданы; dual-read нет).
- `POST /v1/plugins/{id}/reload|restart` → **501** `not_supported` (используйте `POST /v1/system/restart`).
- Health входящего webhook `GET .../health` требует viewer+, если токены настроены.
- WebSocket-чат — только **admin** (как `POST /v1/chat`).
- Bind не loopback без токенов → процесс не стартует.

## Core
- `GET /v1/meta` — api_version, public_url, public_v1, dashboard_url, features
- `GET /v1/health`
- `GET /v1/llm/models` — provider + model id по ролям
- `GET /v1/llm/balance`
- `POST /v1/chat` (admin)
- `POST /v1/system/restart` (maint+) — мягкий рестарт процесса (uvicorn should_exit)
- `PATCH /v1/plugins/{id}` для `lifecycle: resident` — пишет `enabled` и **сразу планирует** мягкий рестарт (`restart_scheduled: true`), иначе Discord/resident-поток продолжает жить со старым манифестом
- `POST /v1/memory/search`
- `POST /v1/memory/write`
- `POST /v1/notify`
- `GET /v1/memory/stats`
- `POST /v1/config/update`
- `POST /v1/backup/run`

## Plugins
- `GET /v1/plugins`
- `GET /v1/plugins/{plugin_id}`
- `PATCH /v1/plugins/{plugin_id}` (`enabled`)
- `GET /v1/plugins/{plugin_id}/config`
- `PUT /v1/plugins/{plugin_id}/config`
- `POST /v1/plugins/{plugin_id}/reload` → **501** `not_supported` (используйте `/v1/system/restart`)
- `POST /v1/plugins/{plugin_id}/restart` → **501** `not_supported`
- `POST /v1/plugins/{plugin_id}/invoke`
- `GET /v1/plugins/operations/{operation_id}`
- `POST /v1/plugins/upload` (multipart, поле `file` — .zip с `plugin.yaml`, admin; `discord` защищён)
- `DELETE /v1/plugins/{plugin_id}` (admin; `discord` защищён; resident → soft restart)
- `GET /v1/plugins/{plugin_id}/files` — список конфиг-файлов модуля
- `GET|PUT /v1/plugins/{plugin_id}/files/{path}` — чтение / запись конфиг-файла (PUT — admin)

## Логи
- `GET /v1/logs?source=&tail=` — хвост лога (viewer+). `source`: `system`, `audit`, `chat`, `health`, `lavalink`, `plugin:{id}`; `tail` 1–2000

## Webhooks / debug
- Исходящие маршруты и deliveries под `/v1/webhooks/...`
- `GET /v1/webhooks/event-types` — список событий для UI (`events`, `groups`; `*` в маршруте = все события)
- Входящие: `POST /v1/webhooks/in/{provider}/{endpoint_id}` (HMAC, если задан secret)
- Health входящего: `GET .../health` (viewer+, если токены настроены)
- `POST /v1/debug/...` (admin; lifecycle за флагом)
