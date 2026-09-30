<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Соавторство: материал создан при поддержке ИИ-агента [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# WebSocket Chat

Endpoint: `ws://127.0.0.1:8787/v1/ws/chat`  
Публично (пример): `wss://neyra.owyx.site/api/v1/ws/chat`

Auth: те же Bearer-роли, что у REST. Предпочтительно `Authorization: Bearer <token>` (`?token=` может попасть в access-логи — только fallback; **маскируйте `token` / `access_token` в логах nginx/Caddy**).

**Роль:** чат по WebSocket — только **admin** (как `POST /v1/chat`). Viewer/maint получают close `1008` (нельзя писать в память / жечь LLM).

Reconnect: открыть **новый** WebSocket (в hello есть `"reconnect":"open_new_socket"`). Буфера resume на сервере в Wave 1 нет.

## Клиент → сервер
- `{"type":"ping"}`
- `{"type":"chat","text":"...","username":"...","platform_user_id":"...","channel_id":"..."}`

## Сервер → клиент
- `hello` (протокол `neyra.ws.chat.v1`, role, idle/ping timeouts)
- `pong`
- `token` (stream chunk)
- `done` (финал + sounds)
- `error`
