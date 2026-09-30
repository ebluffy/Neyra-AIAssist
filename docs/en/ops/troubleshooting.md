<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Co-authored with [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# Troubleshooting

## API unreachable

- Confirm `python server/main.py` is running.
- Check bind host/port in `server/config/server.yaml` (`api.host`, `api.port`) and `API_BIND_HOST` in `server/.env`.
- Inspect `server/logs/system.log`.

## Dashboard shows login/setup loop

- Clear `sessionStorage` for the origin or use a private window.
- If setup fails with 403, perform first-time key creation from localhost when API bind is not loopback.

## Webhooks failing

- Check `/v1/webhooks/deliveries` and `/v1/webhooks/dlq`.
- State file: `server/logs/webhooks_state.json`.

## Public URL / WebSocket issues

- Verify `api.public_base_url` and `api.public_path_prefix` match your proxy (see [api-reverse-proxy](api-reverse-proxy.md)).
- For frp tunnels, see [`docs/PLAN.md`](../../PLAN.md) §3.
