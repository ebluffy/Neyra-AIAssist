# REST Endpoints

Удаление дневника/журнала в Control API является **глобальным действием admin**:
удаление по ID и очистка раздела не ограничиваются владельцем/каналом. Viewer
и maintainer не имеют права удаления. Необязательные owner/channel-фильтры
хранилища служат внутренней фильтрации, а не пользовательской авторизации
этих административных endpoints.

## Контекст Discord и отчёт о моделях (3a)

`POST /v1/chat` и сообщение `chat` в `/v1/ws/chat` принимают необязательный `discord_context`. Старые запросы без поля совместимы.

```json
{
  "text": "Привет",
  "discord_context": {
    "source": "discord",
    "current_user": {"id": "123", "handle": "example", "display_name": "Example"},
    "channel": {"id": "77", "name": "general", "type": "text"},
    "guild": {"id": "88", "name": "Example guild"},
    "message": {"id": "42", "content": "<@999> Привет", "mentions": [{"id": "999"}], "reference": null},
    "addressed_to_bot": true,
    "response_target": {"channel_id": "77", "message_id": "42"}
  }
}
```

Адаптер собирает контекст до удаления обращения к боту. В DM `guild=null`; неизвестный автор reference остаётся `null`. При переданном контексте ID автора/канала и display name берутся из него, а не из старых полей запроса. Имена/текст — данные, не системные инструкции. Target должен совпадать с текущим каналом/сообщением. Неизвестные поля, неверные типы и превышения ограничений отклоняются.

В промпты передаётся отдельный human-блок метаданных без `message.content`, максимум с 10 упоминаниями. Полный типизированный объект остаётся в pipeline. При streaming-повторе с урезанным контекстом блок убирается. Discord запрещает произвольные user/role/everyone-пинги из ответа модели; явный reply может упомянуть автора исходного сообщения.

REST `data.model_trace` и финальный WS `done.model_trace` содержат `turn_id`, UTC `timestamp`, `status`, `error_class`, `queue_wait_ms`, `without_llm` и `calls[]`. `queue_wait_ms` — ожидание сессии канала до старта хода, включая прогрев; оно не входит в длительность вызова. Вызов содержит `lane`, `purpose`, `attempt`, `retry_layer`, `sdk_retries`, `provider`, `configured_model`, `reported_model`, `has_images`, `status`, `error_class`, `headers_ms`, `http_status`, `first_event_ms`, `first_event_type`, `first_text_delta_ms`, `first_meaningful_token_ms`, `duration_ms`. Неизвестное поле остаётся `null`. Отсутствующий ID провайдера — `reported_model=null`, а не подстановка настроенной модели. `attempt` считает вызовы pipeline. `retry_layer` — `stream_timeout`, `stream_error`, `responses_history`, `empty_reply` или `context_overflow`; внутренние повторы SDK считаются отдельно в `sdk_retries`. У вызова также `first_reasoning_ms`, `terminal_event`, `incomplete_reason`, `truncated` и `usage.reasoning_tokens`, когда провайдер их прислал. Если Responses может выдать больше, чем `reply_max_tokens`, стрим и `done.text` режутся одной и той же функцией; при остановке по видимому лимиту `incomplete_reason=visible_cap`, а удалённая цепочка этим хвостом не продолжается. Chat-completions по `max_tokens` так не режется. Повтор Responses из-за истории в стриме ловит обёртка стрима, поэтому слой будет `stream_error`, а класс исключения — `ResponsesRetryable`. В нестриминговом вызове тот же повтор идёт через `invoke` и слой `responses_history`. Brain-native vision отмечается на вызове brain. Успешный ход по-прежнему лежит в `chat_log.meta.model_trace` строк user/assistant. Сорванный или отменённый ход пишется отдельной строкой `role=model_trace` с пустым текстом: её видно в SQLite, и `list_chat` / recall её не отдают в диалог. Завершённые/ошибочные/отменённые ходы публикуются как `llm.turn.completed`. HTTP Responses (метод, путь без query и userinfo, статус, длительность до заголовков у стрима) пишется в `system.log` логгером `neyra.llm.http` на INFO, без тела, ключа и текста.

`GET /v1/llm/activity?limit=20` доступен viewer/maint/admin; limit 1–100. Возвращает `data.items`, новые первыми, из буфера последних 200 ходов. Отчёты не содержат текстов диалога, user/channel IDs, ключей и внутреннего мышления. Буфер очищается при рестарте. Discord `/model` приватно показывает последний собственный ход в текущем канале без вызова LLM.

## Breaking changes (API 1.1.0)

`GET /v1/memory/short` (maint+) возвращает ограниченные окна фактической истории
по owner/channel, без скрытых рассуждений. `GET /v1/memory/long` (maint+)
возвращает до 200 фактов профилей с источником (до 20 на профиль, первые 50
профилей), не полный экспорт Chroma. Дневник автоматический; журнал вынесен в
System → события памяти. Admin delete/wipe API сохранены. Activity также
включает отдельные background reports (`kind`, nullable `parent_turn_id`),
тайминги и usage при наличии. Хранятся отдельно 200 ходов и 200 jobs; выдача
activity объединяет их по времени. Подробнее — [PLAN §12: телеметрия](../../PLAN.md#память-проверка-работы-и-улучшения).

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
