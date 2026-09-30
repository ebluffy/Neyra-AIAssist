<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Соавторство: материал создан при поддержке ИИ-агента [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# API Overview (Control API)

Реализация: `server/core/api/` (не модуль-плагин). Локально: `http://127.0.0.1:8787`.

Публично (если задано): `{api.public_base_url}{api.public_path_prefix}/v1`  
Пример: `https://neyra.owyx.site/api/v1` — см. [api-reverse-proxy](../ops/api-reverse-proxy.md).

## Формат ответов

- success: `{ "ok": true, "trace_id": "...", "data": ... }`
- error: `{ "ok": false, "trace_id": "...", "error": { "code": "...", "message": "..." } }`

## Авторизация

- Header: `Authorization: Bearer <token>`
- Для WS: `Authorization` или query `?token=...`
- Env: `API_TOKEN` (admin), `API_VIEWER_TOKEN`, `API_MAINT_TOKEN`
- Если токены не заданы — роль `anon` и полный доступ **только при bind на loopback** (Wave 1; см. [security-model](../architecture/security-model.md))

## Группы API

- meta, health, chat (+ WS), memory, notify
- plugins, llm (balance, models)
- webhooks, backup, config update, system restart, debug
