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

- `DEEPGRAM_API_KEY` — for STT (speech-to-text recognition) and TTS (text-to-speech, Flux batch REST API, Russian voice flux-polina-ru)
- `GROQ_API_KEY` — alternative STT provider
- `YANDEX_API_KEY`, `YANDEX_FOLDER_ID` — Yandex SpeechKit TTS (fallback when Deepgram TTS is unavailable or fails)
- `SCREEN_PROXY_SECRET`
- `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`
- `AGENT_PROXY_SECRET_KEY`

Set `DEEPGRAM_API_KEY` in `server/.env`; the server injects it into the runtime voice configuration. Deepgram is the default cloud TTS provider. Configure `voice.tts.cloud.deepgram` with `model`, integer `expressivity` (-2 through 2), `sample_rate`, and `timeout_seconds`. If Deepgram fails or its key is missing, TTS uses Yandex when its credentials are available. Existing flat Yandex settings under `voice.tts.cloud` remain supported.

Public URL for the API is **not** in `.env` — set `api.public_base_url` and `api.public_path_prefix` in `server/config/server.yaml`.
