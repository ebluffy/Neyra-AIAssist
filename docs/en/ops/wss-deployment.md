<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Соавторство: материал создан при поддержке ИИ-агента [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# WSS deployment notes

Neyra gateway exposes:

- HTTP API: `/v1/*`
- WebSocket endpoints:
  - `/v1/ws/chat`
  - `/v1/ws/audio`

## Local development

- Start core (includes API): `python server/main.py`
- Use `ws://127.0.0.1:8787/v1/ws/chat` and `ws://127.0.0.1:8787/v1/ws/audio`

## Production

Use a reverse proxy (Nginx, Caddy, Traefik) with TLS termination:

- external clients connect only via `wss://...`
- proxy upstream to local `ws://127.0.0.1:8787`

Important:

- keep `Upgrade` and `Connection` headers for WebSocket upgrade
- forward the `Authorization` header (or use the `?token=` query)
- enforce external HTTPS/WSS only (no plain WS on the public interface)

## Roadmap (Stage 1 — Web UI bridge)

Deploying `wss://` in production is required for external chat/audio clients. **Stage 1** adds a **bidirectional bridge** between the React dashboard and the Event Bus (publish/subscribe over WebSocket), so the browser becomes a first-class real-time control plane — see `PLAN.md`, section «Этап 1». Currently deferred (soak Discord+music first). Until then, the SPA relies mainly on REST `/v1` while `/v1/ws/chat` and `/v1/ws/audio` serve programmatic clients.