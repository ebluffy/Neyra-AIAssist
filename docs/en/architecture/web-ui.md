<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Соавторство: материал создан при поддержке ИИ-агента [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# Web UI (React dashboard)

The dashboard is a **React + Vite + Tailwind CSS** SPA served by the same FastAPI process as the core (`python server/main.py`). Source lives under `server/dashboard/src/`; production assets are built into `server/dashboard/dist`.

Real-time parity with the Event Bus for every dashboard action is **planned** as Stage 1 (bidirectional WebSocket bridge — see `PLAN.md`; deferred until after soak). Today the UI primarily talks to the core over HTTP `/v1`.

## UI sections

- **Home** — landing and feature overview.
- **Dashboard** — health, memory stats, balance, plugin list.
- **Plugins** — plugin state, plugin config editing, invoke / reload / restart.
- **Settings** — Bearer token and runtime allow-list updates.
- **Webhooks** — outbound routes, tests, deliveries / DLQ.
- **API Docs** — embedded Swagger / ReDoc and `openapi.json`.

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

Output goes to `server/dashboard/dist` and is served by Internal API static mounting.