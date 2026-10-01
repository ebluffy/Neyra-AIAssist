<sub>Co-authored with [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# End-user guide

- Start the core: `python server/main.py`.
- Open the web dashboard: `http://127.0.0.1:8787/` (React + Vite + Tailwind SPA).
- **First visit:** the UI asks you to create a **dashboard access key** (at least 8 characters). Remember it — the server stores only a hash. **Later visits:** log in with the same key.
- Chat: Discord plugin (`server/modules/discord`) or HTTP `POST /v1/chat` (requires API admin token when tokens are configured).
- Inspect health, memory, and plugins on **Dashboard**; configure outbound webhooks and the API Bearer token under **Settings** / **Webhooks** as needed.
- Protected `/v1` routes use `Authorization: Bearer` (configured in **Settings**, matches `api.token` in `server/config/server.yaml` / `API_TOKEN` in `server/.env`).

The Windows **Tauri client** (`client/`, Stage 3) is a separate app that will connect with server URL + API token, not the dashboard access key.
