<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Co-authored with [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# WSS deployment notes

## Endpoints

- HTTP API: `/v1/*` (Control API in `server/core/api/`)
- WebSocket:
  - `/v1/ws/chat`
  - `/v1/ws/audio`

Local:

- Start core: `python server/main.py`
- Use `ws://127.0.0.1:8787/v1/ws/chat` and `ws://127.0.0.1:8787/v1/ws/audio`

Public (when `api.public_base_url` + `api.public_path_prefix` are set):

- Example chat: `wss://neyra.owyx.site/api/v1/ws/chat`

## TLS and proxy

Deploying `wss://` in production is required for external chat/audio clients and for the Stage 3 Tauri client. Terminate TLS at Caddy/nginx on the VPS; forward WebSocket upgrades end-to-end (including through **frp** when the server runs on a home server — see [`docs/PLAN.md`](../../PLAN.md) §3 and [api-reverse-proxy](api-reverse-proxy.md)).

Full Event Bus ↔ dashboard WebSocket bridge is backlog; until then the React SPA relies mainly on REST `/v1`, while `/v1/ws/chat` and `/v1/ws/audio` serve programmatic clients.

## Auth

- WebSocket chat requires **admin** (same as `POST /v1/chat`): `Authorization: Bearer` or `?token=` (prefer header).
- With public exposure, tokens in `server/.env` are mandatory; loopback-only anonymous access does not apply.
