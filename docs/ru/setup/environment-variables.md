# Переменные окружения

Основной список: `server/.env.example` (runtime — `server/.env`).

## Критичные
- `OPENROUTER_API_KEY` — ключ LLM провайдера.
- `DISCORD_TOKEN` — токен Discord-бота (если плагин `discord` включён в `server/modules/discord/plugin.yaml`).

## Control API
- `API_TOKEN` — опциональный Bearer для `/v1` и WS.

## Voice / vision / integrations
- `DEEPGRAM_API_KEY` — для STT (распознавание речи) и TTS (озвучка, Flux batch REST API, русский голос flux-polina-ru)
- `GROQ_API_KEY` — альтернативный провайдер STT
- `YANDEX_API_KEY`, `YANDEX_FOLDER_ID` — Yandex SpeechKit TTS (фолбэк при отсутствии/ошибке Deepgram TTS)
- `SCREEN_PROXY_SECRET`
- `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`
- `AGENT_PROXY_SECRET_KEY`