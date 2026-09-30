<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Co-authored with [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# Production deployment (baseline checklist)

- Run under a process manager (systemd/supervisor/Docker `restart: unless-stopped`).
- Set `API_TOKEN` (and viewer/maint tokens if using role separation) in `server/.env`.
- Use a reverse proxy with TLS ([api-reverse-proxy](api-reverse-proxy.md), [wss-deployment](wss-deployment.md)).
- Default bind `127.0.0.1:8787`; do not expose uvicorn directly on the public internet.
- Restrict inbound access to the API; configure the dashboard access key on first setup.
- Schedule backup and watch `GET /v1/health` / health status logs under `server/logs/`.
- Pin dependency versions; run smoke tests after upgrades (`server/scripts/healthcheck.py`).

## Home mini-PC + public URL (Stage 3)

Canonical publish path: Neyra on a **mini-PC**, **frpc** → VPS **frps** → **Caddy**/nginx for `https://neyra.owyx.site` / `wss://neyra.owyx.site/api/v1/ws/chat`. Runtime data remains on the mini-PC (`server/data/memory/`, `server/.env`, `server/logs/`).

Details: [`docs/PLAN.md`](../../PLAN.md) §3.
