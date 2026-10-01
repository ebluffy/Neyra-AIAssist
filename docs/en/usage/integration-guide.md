# Integrator guide

- Send user messages to `POST /v1/chat` (admin token when configured).
- Push contextual events via `POST /v1/notify`.
- Read health/meta: `GET /v1/health`, `GET /v1/meta` (`public_url`, `dashboard_url` when set).

## Streaming

- For streaming UX use `/v1/ws/chat` (admin; public example `wss://neyra.owyx.site/api/v1/ws/chat`).
- For audio use `/v1/ws/audio`.

## Webhooks

- Inbound: `POST /v1/webhooks/in/{provider}/{endpoint_id}`.
- Outbound: routes `event_type -> target_url` via `/v1/webhooks/out/routes`.

Base URL is always your Neyra Control API (`server/core/api/`), not a separate module service.
