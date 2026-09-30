<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Co-authored with [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# Administrator guide

- Check `GET /v1/health`.
- Read logs under `server/logs/` (system log path from config).
- Run backup via `POST /v1/backup/run`.
- Ensure dashboard access key was created before exposing the UI publicly.

## Plugins

- Enable/disable: `PATCH /v1/plugins/{id}`.
- Plugin config: `PUT /v1/plugins/{id}/config`.
- In-process plugin reload/restart may return **501** — use `POST /v1/system/restart` (maint+).

## Webhooks

- Create outbound routes at `/v1/webhooks/out/routes`.
- Track deliveries `/v1/webhooks/deliveries` and DLQ `/v1/webhooks/dlq`.

## Public access

Configure `server/config/server.yaml` (`api.public_*`), TLS reverse proxy, and **mandatory** API tokens. See [deployment-production](../ops/deployment-production.md) and [`docs/PLAN.md`](../../PLAN.md) §3 for frp + home-server layout.
