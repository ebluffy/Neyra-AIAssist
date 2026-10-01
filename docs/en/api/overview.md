<sub>Co-authored with [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# API Overview

Control API package: `server/core/api/` (part of the core, not a plugin). Local base URL: `http://127.0.0.1:8787`.

Public (when configured in `server/config/server.yaml`, section `api:`):  
`{api.public_base_url}{api.public_path_prefix}/v1`  
Example REST: `https://neyra.owyx.site/api/v1` — see [api-reverse-proxy](../ops/api-reverse-proxy.md).  
Example WebSocket chat: `wss://neyra.owyx.site/api/v1/ws/chat`.

## Response shape

- success: `{ "ok": true, "trace_id": "...", "data": ... }`
- error: `{ "ok": false, "trace_id": "...", "error": { "code": "...", "message": "..." } }`

## Auth

- Header: `Authorization: Bearer <token>`
- WS: `Authorization` or query `?token=...` (header preferred on public proxies)
- Env: `API_TOKEN` (admin), `API_VIEWER_TOKEN`, `API_MAINT_TOKEN` in `server/.env`
- **Wave 1:** if no tokens are set, role is `anon` on **loopback bind only**; non-loopback without tokens refuses to start
- **Dashboard gate** (browser SPA): separate access key via `/v1/dashboard/auth/*` — see [web-ui](../architecture/web-ui.md)

## Groups

- meta, health, chat (+ WS stream), memory, notify
- plugins, llm (balance, models)
- webhooks, backup, config update, system restart, debug
- dashboard auth: `GET /v1/dashboard/auth/status`, `POST .../setup`, `POST .../login`
