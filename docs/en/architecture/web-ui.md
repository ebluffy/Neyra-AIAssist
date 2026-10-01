<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Co-authored with [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# Web UI (React dashboard)

The dashboard is a **React + Vite + Tailwind CSS** SPA served by the same FastAPI process as the core (`python server/main.py` from the repo root, or `python main.py` from `server/` cwd). Source: `server/dashboard/src/`; production assets: `server/dashboard/dist`.

The HTTP stack lives in **`server/core/api/`** (Control API), not a plugin module. Settings for bind, public URL, and dashboard behavior are in **`server/config/server.yaml`** (`api:`, `dashboard:`).

Full real-time parity with the Event Bus for every dashboard action is backlog (bidirectional WebSocket bridge — see [`docs/PLAN.md`](../../PLAN.md)). Today the SPA primarily uses HTTP `/v1`.

## Access key gate

Before any dashboard page loads, the SPA runs an **access key** gate:

1. **First visit** (no key stored yet): create a key (minimum **8** characters; a random **hex-32** string is a good default). The server stores a **PBKDF2** hash in `server/data/dashboard_auth.sqlite`.
2. **Later visits:** log in with the same key. The plaintext key is kept in **`sessionStorage`** until logout.
3. **`POST /v1/dashboard/auth/setup`** is allowed only while no key exists. If the API bind address is **not** loopback, setup is accepted **only from a loopback client** (prevents a remote race to claim the key).
4. **`POST /v1/dashboard/auth/login`** and **`GET /v1/dashboard/auth/status`** are public. After a successful gate login the SPA stores the access key and sends it as **`Authorization: Bearer`** for `/v1` calls; the server treats a verified dashboard gate key as **admin** (so the UI no longer needs a second paste of `API_TOKEN`). Dedicated `API_TOKEN` / viewer / maint tokens remain for Discord, MCP, scripts, and Settings override.

This gate is **separate** from the Stage 3 **Tauri client** (`client/`): the desktop app will talk to the same Control API with server URL + API token, not the dashboard access key flow.

## UI sections

- **Home** — landing and feature overview.
- **Dashboard** — health, memory stats, balance, plugin list.
- **Plugins** — plugin state, plugin config editing, invoke / reload / restart.
- **Settings** — Bearer token and runtime allow-list updates.
- **Webhooks** — outbound routes, tests, deliveries / DLQ.
- **API Docs** — embedded Swagger / ReDoc and `openapi.json`.

(There is no microsite tab; public marketing pages are out of scope for this SPA.)

## Development

```bash
cd server/dashboard
npm install
npm run dev
```

The dev server proxies API routes in `vite.config.ts` (`/v1`, `/docs`, `/redoc`, `/openapi.json`).

## Production build

```bash
cd server/dashboard
npm run build
```

Output goes to `server/dashboard/dist` and is served by the Control API static mount.
