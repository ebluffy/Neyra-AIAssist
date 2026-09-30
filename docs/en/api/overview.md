<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Соавторство: материал создан при поддержке ИИ-агента [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# API Overview

Core package: `server/core/api/`. Local base URL: `http://127.0.0.1:8787`.

Public (when configured): `{api.public_base_url}{api.public_path_prefix}/v1`  
Example: `https://neyra.owyx.site/api/v1` — see [api-reverse-proxy](../ops/api-reverse-proxy.md).

## Response shape

- success: `{ "ok": true, "trace_id": "...", "data": ... }`
- error: `{ "ok": false, "trace_id": "...", "error": { "code": "...", "message": "..." } }`

## Auth

- Header: `Authorization: Bearer <token>`
- WS: `Authorization` or query `?token=...`
- Env: `API_TOKEN` (admin), `API_VIEWER_TOKEN`, `API_MAINT_TOKEN`
- If none are set, auth is off (local/dev only)

## Groups

- meta, health, chat (+ WS stream), memory, notify
- plugins, llm (balance, models)
- webhooks, backup, config update, system restart, debug
