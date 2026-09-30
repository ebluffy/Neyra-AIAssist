<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Соавторство: материал создан при поддержке ИИ-агента [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# Гайд интегратора

Control API живёт в `server/core/api/` (не модуль). Локально: `http://127.0.0.1:8787`. Публично (Этап 3): `https://neyra.owyx.site/api/v1` — см. [api-reverse-proxy](../ops/api-reverse-proxy.md) и [`docs/PLAN.md`](../../PLAN.md) §3. Auth: Bearer `API_TOKEN` (и роли viewer/maint).

## Через REST
- Отправляйте пользовательские сообщения в `POST /v1/chat`.
- Получайте контекстные события через `POST /v1/notify`.

## Через WebSocket
- Для потокового UX используйте `/v1/ws/chat` (публично `wss://neyra.owyx.site/api/v1/ws/chat`).
- Для аудио-кейсов используйте `/v1/ws/audio`.

## Через Webhooks
- Inbound: `POST /v1/webhooks/in/{provider}/{endpoint_id}`.
- Outbound: маршруты `event_type -> target_url` через `/v1/webhooks/out/routes`.