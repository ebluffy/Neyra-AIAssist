<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Соавторство: материал создан при поддержке ИИ-агента [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# Справочник config.yaml

`config.yaml` содержит только базовый runtime-конфиг ядра.

## Ключевые секции
- `assistant` — `name`, `persona_path` / `appearance_path` (persona pack), `system_prompt` как fallback
- `agent.fast_path` — allowlist команд умного дома (выкл. по умолчанию; публикует `home.*`; e2e клиенты — этап 2 плана)
- `BACKEND`, `openrouter`, `llm` — модели и лимиты по ролям: вложенные **`talk_model`**, **`brain_model`**, **`memory_model`**, **`vision_model`** (VL и пайплайн зрения в одном блоке; корневого **`vision:`** больше нет).
- `memory` — Hub/RAG; опц. `pre_context`; опц. `session_archive` (архив STM при overflow/reset; выкл. по умолчанию)
- `voice` — по модальностям: `stt` / `tts` с `prefer` + `local`/`cloud`.`enable` (soft ERROR если не настроено; legacy `voice_cloud` / `is_local` ещё нормализуются). Cloud STT: `provider` = `deepgram` | `groq` | `openrouter` (Whisper через `POST …/audio/transcriptions`, ключ `OPENROUTER_API_KEY`, опц. `upload_mode`: `multipart`|`json`).
- `health_monitor`
- `backup`, `external_storage`
- `logging`

## Вынесено в плагины
- `discord` -> `server/modules/discord/config.yaml`
- `internal_api`, `dashboard` -> `server/modules/internal_api/config.yaml`
- локальные plugin settings -> `server/modules/<id>/config.yaml`

## Запрещено хранить в yaml
- API keys и токены. Используйте `.env`.