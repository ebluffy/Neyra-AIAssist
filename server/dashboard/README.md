# Neyra server dashboard

React + Vite + Tailwind SPA under `server/dashboard/`. Production build goes to `dist/` and is served by the Control API (`server/core/api/`) together with `/v1`.

This is the **server** web UI (ops fallback). The product Windows app lives in `client/` and must not reuse this package.

## Access-key gate

- First visit: create an access key (≥ 8 characters, or hex-32). Hash stored with PBKDF2 in SQLite under the data dir (`dashboard_auth` DB).
- Later: login with that key; SPA keeps plaintext in `sessionStorage` until logout.
- If the API binds to a non-loopback address, initial **setup** is allowed only from a **loopback** client.
- Independent of API Bearer tokens (`API_TOKEN` / viewer / maint).

Endpoints: `/v1/dashboard/auth/setup`, `/v1/dashboard/auth/login`, status/logout variants — see OpenAPI `/docs`.

## Develop

```bash
cd server/dashboard
npm install
npm run dev
```

Vite proxies `/v1`, `/docs`, `/redoc`, `/openapi.json` to the running server (see `vite.config.ts`).

## Build

```bash
cd server/dashboard
npm install
npm run build
```

Then start the server from `server/` (`python main.py`). Open `http://127.0.0.1:8787/`.

## Docs

- RU: [docs/ru/architecture/web-ui.md](../../docs/ru/architecture/web-ui.md)
- EN: [docs/en/architecture/web-ui.md](../../docs/en/architecture/web-ui.md)
- Security / gate: [docs/ru/architecture/security-model.md](../../docs/ru/architecture/security-model.md)
