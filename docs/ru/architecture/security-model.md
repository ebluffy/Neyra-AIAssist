<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Соавторство: материал создан при поддержке ИИ-агента [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# Модель безопасности

## Граница доверия
- Internal API по умолчанию слушает `127.0.0.1`. Всё нелокальное считай недоверенным, пока не закрыто.
- Если **не задан ни один** из `INTERNAL_API_TOKEN` / `INTERNAL_API_VIEWER_TOKEN` / `INTERNAL_API_MAINT_TOKEN`, API **анонимный** (удобство для dev). На общем/удалённом хосте токены обязательны.
- Роли: `viewer` — чтение memory/search/people; `admin` — чат и мутации. Давай минимум прав.

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
