<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Co-authored with [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# Environment variables

Canonical list: `server/.env.example`.

## Critical

- `OPENROUTER_API_KEY` — OpenRouter LLM provider.
- `AIHOPE_API_KEY` — AIHope (OpenAI-compatible) when used for brain/memory/vision roles.
- `DISCORD_TOKEN` — Discord bot token (when `server/modules/discord/plugin.yaml` has `enabled: true`).

## Control API (`server/core/api`)

- `API_TOKEN` — Bearer **admin** token for `/v1` and WebSocket chat.
- `API_VIEWER_TOKEN`, `API_MAINT_TOKEN` — read-only and maintenance roles.
- `API_BIND_HOST` — override bind host (default loopback; required for LAN/Docker with tokens).
- `NEYRA_DATA_DIR` — override data directory (default under `server/data/`).

## Voice / vision / integrations

- `DEEPGRAM_API_KEY`, `GROQ_API_KEY`, `YANDEX_API_KEY`, `YANDEX_FOLDER_ID`
- `SCREEN_PROXY_SECRET`
- `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`
- `AGENT_PROXY_SECRET_KEY`

Public URL for the API is **not** in `.env` — set `api.public_base_url` and `api.public_path_prefix` in `server/config/server.yaml`.
