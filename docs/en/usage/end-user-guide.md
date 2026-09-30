<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Соавторство: материал создан при поддержке ИИ-агента [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# End-user guide

- Start the core: `python server/main.py`.
- Open the web dashboard: `http://127.0.0.1:8787/` (React + Vite + Tailwind SPA).
- Chat: Discord plugin (`server/modules/discord`) or HTTP `POST /v1/chat`.
- Inspect health, memory, plugins on **Dashboard**; configure outbound webhooks and API token under **Settings** / **Webhooks** as needed.
- Protected `/v1` routes require the Bearer token configured in **Settings** (matches `api.token` in `config.yaml`).