# Web UI (React dashboard)

The dashboard is a **React + Vite + Tailwind CSS** SPA served by the same FastAPI process as the core. Source: `server/dashboard/src/`; build: `server/dashboard/dist`.

HTTP lives in **`server/core/api/`**. Bind / public URL / dashboard flags: **`server/config/server.yaml`** (`api:`, `dashboard:`).

**Role:** primary Neyra ops workspace (status, modules, memory, system, webhooks, settings, docs) for local and remote (VPS / public domain) use. Also a Stage 3 Tauri screen polygon: `api/`, `components/ui/`, `screens/`, `styles/`. Web-only: `shell/` (AuthGate + sessionStorage). No chat UI. UI is Russian-first for now; bilingual dashboard later.

## Access key gate

1. First visit: create key (min **32** chars). PBKDF2 hash in `server/data/dashboard_auth.sqlite`.
2. Later: login → **`session_token`** in `sessionStorage` (session hashes also persisted in SQLite).
3. Setup only while unconfigured; non-loopback bind → setup from loopback only.
4. Raw gate key is **not** accepted as Bearer. Logout revokes the session.

## UI sections

| Nav | Route | Purpose |
|-----|-------|---------|
| Status | `/status` | health, models, balance, soft-restart (`/dashboard` redirects) |
| Modules | `/modules` | toggle/config/invoke/reload/restart (`/plugins` redirects; API still `/v1/plugins`) |
| Memory | `/memory` | stats, people, diary, search, LTM |
| System | `/system` | meta, backup, DLQ summary |
| Webhooks | `/webhooks` | routes, deliveries, DLQ |
| Settings | `/settings` | Bearer override + runtime config allowlist |
| API Docs | `/api-docs` | Swagger / ReDoc / Markdown |

## Runtime config

- `GET /v1/config/runtime` — allowlisted values (no `.env` secrets).
- `POST /v1/config/update` — write the same keys.

## Develop / build

```bash
cd server/dashboard
npm install
npm run dev   # or npm run build → dist/
```
