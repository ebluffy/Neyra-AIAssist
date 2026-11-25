# WebSocket Chat

Endpoint: `ws://127.0.0.1:8787/v1/ws/chat`  
Public (example): `wss://neyra.owyx.site/api/v1/ws/chat`

Auth: same Bearer roles as REST. Prefer `Authorization: Bearer <token>` (query `?token=` may appear in access logs — fallback only; **mask `token` / `access_token` in nginx/Caddy access logs**).

**Role:** WebSocket chat requires **admin**, or **web** with a valid `X-Neyra-Identity` (same as `POST /v1/chat` for admin). Viewer/maint receive close `1008` — they must not stream chat (memory writes / LLM spend).

Reconnect: open a **new** WebSocket (hello includes `"reconnect":"open_new_socket"`). No server-side resume buffer in Wave 1.

## Client → server
- `{"type":"ping"}`
- `{"type":"chat","text":"...","username":"...","platform_user_id":"...","channel_id":"...","model":"qwen/qwen3.8-27b:free"}`
  - `model` is optional; it is a model id of the current talk provider (the provider is not switched); without it `llm.talk_model` is used. The `web` role may use only the default and ids in `llm.chat_models_allowed_for_web`.
- `{"type":"stop"}` — cancel the current answer without closing the WebSocket.

## Server → client
- `hello` (protocol `neyra.ws.chat.v1`, role, idle/ping timeouts)
- `pong`
- `token` (stream chunk)
- `phase` (retrieval/plan/answer)
- `done` (final + sounds + usage + `turn_stats`: per-lane timing, tokens/s, model)
- `stopped` — acknowledgement for `stop`
- `error` (including `busy` when a new `chat` arrives while an answer is streaming, and `model_not_allowed` for a forbidden override)
