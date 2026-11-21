# WebSocket Chat

Endpoint: `ws://127.0.0.1:8787/v1/ws/chat`  
Public (example): `wss://neyra.owyx.site/api/v1/ws/chat`

Auth: same Bearer roles as REST. Prefer `Authorization: Bearer <token>` (query `?token=` may appear in access logs — fallback only; **mask `token` / `access_token` in nginx/Caddy access logs**).

**Role:** WebSocket chat requires **admin** (same as `POST /v1/chat`). Viewer/maint receive close `1008` — they must not stream chat (memory writes / LLM spend).

Reconnect: open a **new** WebSocket (hello includes `"reconnect":"open_new_socket"`). No server-side resume buffer in Wave 1.

## Client → server
- `{"type":"ping"}`
- `{"type":"chat","text":"...","username":"...","platform_user_id":"...","channel_id":"...","model":"provider/model"}`
  - `model` is optional; without it `llm.talk_model` is used.
- `{"type":"stop"}` — cancel the current answer without closing the WebSocket.

## Server → client
- `hello` (protocol `neyra.ws.chat.v1`, role, idle/ping timeouts)
- `pong`
- `token` (stream chunk)
- `phase` (retrieval/plan/answer)
- `done` (final + sounds + usage)
- `stopped` — acknowledgement for `stop`
- `error` (including `busy` when a new `chat` arrives while an answer is streaming)
