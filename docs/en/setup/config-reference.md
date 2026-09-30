<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Соавторство: материал создан при поддержке ИИ-агента [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# Справочник config.yaml

`config.yaml` содержит только базовый runtime-конфиг ядра.

## Key sections
- `assistant` — `name`, `persona_path` / `appearance_path` (persona pack), `system_prompt` fallback
- `agent.fast_path` — regex allowlist for home commands (off by default; publishes `home.*`; multi-client e2e → plan stage 2)
- `llm` — per-role nested blocks: **`talk_model`**, **`brain_model`**, **`memory_model`**, **`vision_model`** (VL + vision pipeline). Each role sets **`provider`**. Provider base URLs under **`llm.providers.<name>`**. No top-level `BACKEND` / `openrouter:` / `vision:`.
- `memory` — Hub/RAG; optional `pre_context`; optional `session_archive` (STM archive on overflow/reset; off by default)
- `voice` — per modality: `stt` / `tts` each with `prefer` + `local`/`cloud`.`enable` (soft ERROR if unset; legacy `voice_cloud` / `is_local` still normalized). Cloud STT: `provider` = `deepgram` | `groq` | `openrouter` (Whisper via `POST …/audio/transcriptions`, same `OPENROUTER_API_KEY`, optional `upload_mode`: `multipart`|`json`).
- `health_monitor`
- `backup`, `external_storage`
- `logging`

## Вынесено в плагины
- `discord` -> `server/modules/discord/config.yaml`
- `api`, `dashboard` -> `server/config/server.yaml (api:)`
- локальные plugin settings -> `server/modules/<id>/config.yaml`

## Запрещено хранить в yaml
- API keys и токены. Используйте `.env`.