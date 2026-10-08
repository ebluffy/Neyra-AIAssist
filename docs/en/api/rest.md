# REST Endpoints

## Breaking changes (API 1.1.0)

- Env: `INTERNAL_API_*` → `API_*` (startup fails if old names are set; no dual-read).
- `POST /v1/plugins/{id}/reload|restart` → **501** `not_supported` (use `POST /v1/system/restart`).
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

## Plugins
- `GET /v1/plugins`
- `GET /v1/plugins/{plugin_id}`
- `PATCH /v1/plugins/{plugin_id}` (`enabled`)
- `GET /v1/plugins/{plugin_id}/config`
- `PUT /v1/plugins/{plugin_id}/config`
- `POST /v1/plugins/{plugin_id}/reload` → **501** `not_supported` (use `/v1/system/restart`)
- `POST /v1/plugins/{plugin_id}/restart` → **501** `not_supported`
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
- `GET /v1/webhooks/event-types` — event list for the UI (`events`, `groups`; route `*` = all events)
- Inbound: `POST /v1/webhooks/in/{provider}/{endpoint_id}` (HMAC if secret set)
- Inbound health: `GET .../health` (viewer+ when tokens configured)
- `POST /v1/debug/...` (admin; lifecycle gated by flag)
