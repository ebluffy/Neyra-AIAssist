# REST Endpoints

Diary/journal management in the Control API is **admin-global**: deleting an
entry by ID or wiping a section acts across owners/channels. These routes
require the admin role; viewer/maintainer tokens do not grant deletion rights.
Optional owner/channel filters in the storage layer are internal filtering
tools, not per-user authorization for these administrative endpoints.

## Discord context and model evidence (3a)

`POST /v1/chat` and WS `/v1/ws/chat` chat messages accept optional `discord_context`. Legacy requests remain compatible. The object contains `source: "discord"`, `current_user` (id/handle/display_name), `channel` (id/name/type), nullable `guild` (id/name), `message` (id/content/mentions/reference), `addressed_to_bot`, and `response_target` (channel_id/message_id). See the complete JSON example in the [Russian reference](../../ru/api/rest.md).

The Discord adapter captures metadata before removing the bot mention. DM guilds and unresolved reference authors are null. Context author/channel IDs override legacy request identity fields. Names and content are untrusted data, not system instructions. Response targets must match the current message/channel; unknown fields and invalid or oversized data are rejected.

Prompts receive a separate human-role metadata block without `message.content`, with at most 10 mentions. The full typed object remains available to the pipeline. The block is omitted from the reduced-context streaming retry. Discord disables model-generated user/role/everyone mentions; an explicit reply may mention its author.

REST `data.model_trace` and WS `done.model_trace` contain `turn_id`, UTC `timestamp`, `status`, `error_class`, `queue_wait_ms`, `without_llm`, and `calls[]`. `queue_wait_ms` is the channel/session wait before the turn starts, including warmup, and is separate from call duration. Each call records `lane`, `purpose`, `attempt`, `retry_layer`, `sdk_retries`, `provider`, `configured_model`, nullable `reported_model`, `has_images`, `status`, `error_class`, and, when observed, `headers_ms`, `http_status`, `first_event_ms`, `first_event_type`, `first_text_delta_ms`, `first_meaningful_token_ms`, and `duration_ms`. Unknown values stay null. Missing provider evidence is never replaced with the configured model. `attempt` counts pipeline calls. `retry_layer` is `stream_timeout`, `stream_error`, `responses_history`, `empty_reply`, or `context_overflow`; SDK-internal retries are `sdk_retries` only. A Responses history retry during streaming is caught by the stream wrapper, so the layer is `stream_error` and the call's `error_class` is `ResponsesRetryable`. The same retry in a non-streaming `invoke` is `responses_history`. Brain-native images are attributed to the brain call. Successful turns still persist evidence on the user/assistant `chat_log` rows. Failed and cancelled turns are stored as an empty-text `role=model_trace` row, visible in SQLite and omitted from `list_chat` / recall. Terminal reports are also published as `llm.turn.completed`. Responses HTTP lines (method, path without query or userinfo, status, duration) go to `system.log` via `neyra.llm.http` at INFO, with no body, key, or message text.

`GET /v1/llm/activity?limit=20` requires viewer or higher, with limit 1–100. It returns `data.items`, newest first, from an in-process buffer of 200 turns. Reports exclude dialogue content, owner/channel IDs, secrets, and internal reasoning. Restart clears the buffer. Discord `/model` privately reports the caller's last turn in the current channel without an LLM call.

## Breaking changes (API 1.1.0)

`GET /v1/memory/short` (maint+) returns bounded actual process-history windows
by owner/channel, without hidden reasoning. `GET /v1/memory/long` (maint+)
returns up to 200 profile facts with sources (up to 20 per profile, first 50
profiles); this is not a complete Chroma export. Diary remains automatic and
the journal is shown under System → memory events. Admin delete/wipe routes
are unchanged. Both activity and model evidence now include independent
background reports (`kind`, nullable `parent_turn_id`), timings and usage when
reported. Retention is 200 turns plus 200 jobs; activity returns the newest
requested items across both. See [PLAN §12: telemetry](../../PLAN.md#память-проверка-работы-и-улучшения).

- Env: `INTERNAL_API_*` → `API_*` (startup fails if old names are set; no dual-read).
- `POST /v1/plugins/{id}/reload|restart` — on_demand: hot re-import; resident: core soft-restart (`restart_scheduled`).
- Inbound webhook health `GET .../health` requires viewer+ when tokens are configured.
- WebSocket chat requires **admin** (aligned with `POST /v1/chat`).
- Non-loopback bind without tokens → process refuses to start.

## Dashboard auth (SPA gate)

- `GET /v1/dashboard/auth/status` — whether an access key exists (public)
- `POST /v1/dashboard/auth/setup` — one-time key creation (public; loopback client if bind is non-loopback)
- `POST /v1/dashboard/auth/login` — verify key (public)

See [web-ui](../architecture/web-ui.md). Separate from Control API Bearer tokens.

## Core

- `GET /v1/meta` — api_version, public_url, public_v1, dashboard_url, features
- `GET /v1/health`
- `GET /v1/llm/models` — per-role provider + model id
- `GET /v1/llm/balance`
- `POST /v1/chat` (admin)
- `POST /v1/system/restart` (maint+) — soft process restart (uvicorn should_exit)
- `PATCH /v1/plugins/{id}` for `lifecycle: resident` — writes `enabled`; soft restart is scheduled **only when** `enabled` actually changes (`enabled_changed: true`, `restart_scheduled: true`). A no-op PATCH does not bounce the core.
- `POST /v1/memory/search`
- `POST /v1/memory/write`
- `POST /v1/notify`
- `GET /v1/memory/stats`
- `POST /v1/config/update`
- `POST /v1/backup/run`
- `GET /v1/backup/list` — local BackupManager zip archives + `last_restore_apply` (`applied`/`failed`)
- `POST /v1/backup/restore` — `{ archive_name, confirm: "RESTORE" }` (admin); validates archive, then `pre_restore` backup, then stages a pending swap; live memory is replaced only on core start (soft-restart required); does not touch logs/

## Plugins
- `GET /v1/plugins`
- `GET /v1/plugins/{plugin_id}`
- `PATCH /v1/plugins/{plugin_id}` (`enabled`)
- `GET /v1/plugins/{plugin_id}/config`
- `PUT /v1/plugins/{plugin_id}/config`
- `GET /v1/plugins/{plugin_id}/log-sources` — module log sources (module.log, sidecars)
- `POST /v1/plugins/{plugin_id}/reload` — on_demand: `reload_plugin`; resident → soft-restart
- `POST /v1/plugins/{plugin_id}/restart` — same (resident → soft-restart)
- `POST /v1/plugins/{plugin_id}/invoke`
- `GET /v1/plugins/operations/{operation_id}`
- `POST /v1/plugins/upload` (multipart field `file` — .zip with `plugin.yaml`, admin; `discord` is protected)
  - If the module already exists → **409** `already_exists` unless `?replace=true` (UI confirms).
  - On replace: `config.yaml` / `logs/` / `data/` are copied into staging **before** the swap; the old tree becomes `.{id}.old-*` (kept as the last backup; older `.old` dirs are cleaned at the start of the next upload). If anything fails after the swap, `.old` is not deleted.
  - Installed `plugin.yaml` is forced to `enabled: false` (enable manually).
  - Replacing a resident module schedules soft restart (`restart_scheduled: true`).
- `DELETE /v1/plugins/{plugin_id}` (admin; `discord` is protected; resident → soft restart)
- `GET /v1/plugins/{plugin_id}/files` — list module config files (suffix allowlist)
- `GET|PUT /v1/plugins/{plugin_id}/files/{path}` — read / write config-like files only (PUT is admin; GET is viewer+)

## Logs
- `GET /v1/logs?source=&tail=` — log tail (viewer+). `source`: `system`, `audit`, `chat`, `health`, `lavalink`, `plugin:{id}`; `tail` 1–2000

## Webhooks / debug
- Outbound routes and deliveries under `/v1/webhooks/...`
- Outbound delivery: when `secret` is set — headers `x-neyra-webhook-secret`, `X-Neyra-Timestamp`, `X-Neyra-Signature: sha256=<hmac>` where HMAC-SHA256(`secret`, `"{timestamp}.{body}"`)
- `GET /v1/webhooks/event-types` — event list for the UI (`events`, `groups`; route `*` = all events)
- `POST /v1/webhooks/dlq/retry-all` — accept retry of all DLQ deliveries (**202**; originals leave DLQ; a failed retry adds one replacement row)
- Inbound: `POST /v1/webhooks/in/{provider}/{endpoint_id}` (HMAC if secret set)
- Inbound health: `GET .../health` (viewer+ when tokens configured)
- `POST /v1/debug/...` (admin; lifecycle gated by flag)
