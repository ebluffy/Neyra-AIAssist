# REST Endpoints

## Breaking changes (API 1.1.0)

- Env: `INTERNAL_API_*` → `API_*` (старт падает, если старые имена заданы; dual-read нет).
- `POST /v1/plugins/{id}/reload|restart` — on_demand: hot re-import; resident: soft-restart ядра (`restart_scheduled`).
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
- `PATCH /v1/plugins/{id}` для `lifecycle: resident` — пишет `enabled`; мягкий рестарт планируется **только если** `enabled` реально изменился (`enabled_changed: true`, `restart_scheduled: true`). No-op PATCH ядро не трогает
- `POST /v1/memory/search`
- `POST /v1/memory/write`
- `POST /v1/notify`
- `GET /v1/memory/stats`
- `POST /v1/config/update`
- `POST /v1/backup/run`
- `GET /v1/backup/list` — локальные zip-архивы BackupManager + `last_restore_apply` (`applied`/`failed`)
- `POST /v1/backup/restore` — `{ archive_name, confirm: "RESTORE" }` (admin); сначала проверка архива, затем `pre_restore` бэкап, затем staging + pending; живая память меняется только при старте ядра (soft-restart обязателен); логи не трогаются

## Plugins
- `GET /v1/plugins`
- `GET /v1/plugins/{plugin_id}`
- `PATCH /v1/plugins/{plugin_id}` (`enabled`)
- `GET /v1/plugins/{plugin_id}/config`
- `PUT /v1/plugins/{plugin_id}/config`
- `GET /v1/plugins/{plugin_id}/log-sources` — источники логов модуля (module.log, sidecar)
- `POST /v1/plugins/{plugin_id}/reload` — on_demand: `reload_plugin`; resident → soft-restart
- `POST /v1/plugins/{plugin_id}/restart` — то же (resident → soft-restart)
- `POST /v1/plugins/{plugin_id}/invoke`
- `GET /v1/plugins/operations/{operation_id}`
- `POST /v1/plugins/upload` (multipart, поле `file` — .zip с `plugin.yaml`, admin; `discord` защищён)
  - По умолчанию, если модуль уже есть → **409** `already_exists`. Замена только с `?replace=true` (UI спрашивает confirm).
  - При replace: `config.yaml` / `logs/` / `data/` копируются в staging **до** подмены; старый код → `.{id}.old-*` (остаётся последним бэкапом; предыдущие `.old` чистятся в начале следующего upload). При сбое после подмены `.old` не удаляется.
  - После установки в `plugin.yaml` принудительно `enabled: false` (включи вручную).
  - Замена resident → soft restart (`restart_scheduled: true`).
- `DELETE /v1/plugins/{plugin_id}` (admin; `discord` защищён; resident → soft restart)
- `GET /v1/plugins/{plugin_id}/files` — список конфиг-файлов модуля (allowlist суффиксов)
- `GET|PUT /v1/plugins/{plugin_id}/files/{path}` — чтение / запись только конфиг-подобных файлов (PUT — admin; GET — viewer+)

## Логи
- `GET /v1/logs?source=&tail=` — хвост лога (viewer+). `source`: `system`, `audit`, `chat`, `health`, `lavalink`, `plugin:{id}`; `tail` 1–2000

## Webhooks / debug
- Исходящие маршруты и deliveries под `/v1/webhooks/...`
- Исходящая доставка: при наличии `secret` — заголовки `x-neyra-webhook-secret`, `X-Neyra-Timestamp`, `X-Neyra-Signature: sha256=<hmac>` где HMAC-SHA256(`secret`, `"{timestamp}.{body}"`)
- `GET /v1/webhooks/event-types` — список событий для UI (`events`, `groups`; `*` в маршруте = все события)
- `POST /v1/webhooks/dlq/retry-all` — принять повтор всех доставок из DLQ (**202**; исходные записи снимаются с DLQ, при неудаче появляется одна новая)
- Входящие: `POST /v1/webhooks/in/{provider}/{endpoint_id}` (HMAC, если задан secret)
- Health входящего: `GET .../health` (viewer+, если токены настроены)
- `POST /v1/debug/...` (admin; lifecycle за флагом)
