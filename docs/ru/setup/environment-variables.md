<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Соавторство: материал создан при поддержке ИИ-агента [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# Переменные окружения

Основной список: `.env.example`.

## Критичные
- `OPENROUTER_API_KEY` — ключ LLM провайдера.
- `DISCORD_TOKEN` — токен Discord-бота (если плагин `discord` включён в `server/modules/discord/plugin.yaml`).

## Internal API
- `INTERNAL_API_TOKEN` — опциональный Bearer для `/v1` и WS.

## Voice / vision / integrations
- `DEEPGRAM_API_KEY`, `GROQ_API_KEY`, `YANDEX_API_KEY`, `YANDEX_FOLDER_ID`
- `SCREEN_PROXY_SECRET`
- `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`
- `AGENT_PROXY_SECRET_KEY`