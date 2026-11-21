# WebSocket Chat

Endpoint: `ws://127.0.0.1:8787/v1/ws/chat`  
Публично (пример): `wss://neyra.owyx.site/api/v1/ws/chat`

Auth: те же Bearer-роли, что у REST. Предпочтительно `Authorization: Bearer <token>` (`?token=` может попасть в access-логи — только fallback; **маскируйте `token` / `access_token` в логах nginx/Caddy**).

**Роль:** чат по WebSocket — **admin** или **web** с валидным `X-Neyra-Identity` (как `POST /v1/chat` для админа). Viewer/maint получают close `1008` (нельзя писать в память / жечь LLM).

Reconnect: открыть **новый** WebSocket (в hello есть `"reconnect":"open_new_socket"`). Буфера resume на сервере в Wave 1 нет.

## Клиент → сервер
- `{"type":"ping"}`
- `{"type":"chat","text":"...","username":"...","platform_user_id":"...","channel_id":"...","model":"qwen/qwen3.8-27b:free"}`
  - `model` необязателен; это id модели текущего talk-провайдера, провайдер не меняется; без него используется `llm.talk_model`. Для роли `web` доступны только default и id из `llm.chat_models_allowed_for_web`.
- `{"type":"stop"}` — отменить текущий ответ, не закрывая WebSocket.

## Сервер → клиент
- `hello` (протокол `neyra.ws.chat.v1`, role, idle/ping timeouts)
- `pong`
- `token` (stream chunk)
- `phase` (этап retrieval/plan/answer)
- `done` (финал + sounds + usage)
- `stopped` — подтверждение `stop`
- `error` (включая `busy`, если пришёл новый `chat` во время ответа, и `model_not_allowed` для запрещённого override)
