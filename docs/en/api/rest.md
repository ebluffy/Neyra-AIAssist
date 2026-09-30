<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Соавторство: материал создан при поддержке ИИ-агента [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# REST Endpoints

## Core
- `GET /v1/meta` — api_version, public_url, features
- `GET /v1/health`
- `GET /v1/llm/models` — per-role provider + model id
- `GET /v1/llm/balance`
- `POST /v1/chat`
- `POST /v1/system/restart` (maint+) — process soft-restart
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

## Webhooks / debug
- Outbound routes and deliveries under `/v1/webhooks/...`
- Inbound: `POST /v1/webhooks/in/{provider}/{endpoint_id}` (HMAC if secret set)
- Inbound health: `GET .../health` (viewer+ when tokens configured)
- `POST /v1/debug/...` (admin; lifecycle gated by flag)
