<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Соавторство: материал создан при поддержке ИИ-агента [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# Модель безопасности

## Граница доверия
- Neyra API (`core.api`) по умолчанию слушает `127.0.0.1`. Всё нелокальное — недоверенное, пока не закрыто.
- **Политика Wave 1 (осознанно):** если **не задан ни один** из `API_TOKEN` / `API_KEY` / `API_VIEWER_TOKEN` / `API_MAINT_TOKEN`, роль `anon` и доступ ко всем эндпоинтам **только при bind на loopback**. Non-loopback без токенов → процесс не стартует (`assert_api_bind_safe`). Обязательные токены даже на localhost — отдельное ужесточение, не Wave 1.
- Когда токены заданы: `viewer` — чтение; `maint+` — soft-restart; `admin` — чат/мутации. Минимум прав.

## Секреты
- Секреты только в `.env`; `apply_env_secrets` подставляет при старте. **Не коммить** `config.yaml`, plugin `config.yaml`, `.env`.
- MCP `neyra_read_config` маскирует секретные ключи (`api_key`, `*_token`, `*_secret`, `api_hash`, …). Живые ключи в YAML всё равно не клади.
- Не логируй `Authorization` и сырые API keys.

## Изоляция памяти
- Хронологический `recall_chat` / `POST /v1/memory/chat/recall` **требуют** `user_id` и/или `channel_id`.
- Семантический `search_memory` / `POST /v1/memory/search` **требуют** `user_id` (диалоги и `session_archive_digest` — только owner; общий shared — лишь `type=knowledge`). Аргумент `user_id` у tool игнорируется в пользу turn-scope (`ContextVar`).
- `session_archive` LTM digest строится только из **user-scoped `chat_log`**, не из process-global STM (иначе чужие реплики могли бы присвоиться текущему uid).
- RAG в `prepare_turn` идёт через тот же user-scoped поиск.

## Плагины
- Plugin builder пишет только внутрь `server/modules/<plugin_id>/` (path jail, без `../`).
- MCP расширяет поверхность атаки — allowlist серверов и аудит tools.

## Бэкапы и ops — не коммитить
- `.env`, корневой и `server/modules/**/config.yaml`
- `memory/*.db*`, Chroma, `memory/working_memory/`, артефакты diary/journal
- `logs/*` (в т.ч. `webhooks_state.json` — могут быть payload’ы)
- `backups/` — как PII; хранить шифрованно / с контролем доступа

## Бесплатные / trial модели (`:free`)
- Эндпоинты OpenRouter / NVIDIA `:free` провайдер может логировать или переиспользовать.
- **Не** отправляй PII, голос, лица и приватный Discord-контент на `:free` без осознанного согласия.
- Для чувствительного audio/vision — paid/BYOK или локальные модели.

## Webhooks
- У outbound-маршрутов может быть `secret`. Логи доставок/DLQ — `logs/webhooks_state.json`, считай чувствительными.
