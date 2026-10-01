<sub>Соавторство: материал создан при поддержке ИИ-агента [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# Справочник `server/config.yaml`

`server/config.yaml` содержит только короткий корневой runtime-конфиг ядра (assistant, paths, указатели на слои).

## Ключевые секции

- `assistant` — `name`, `persona_path` / `appearance_path` (persona pack), `system_prompt` как fallback
- `paths.data_dir` — корень runtime-данных (default `server/data` от корня репо; override — `NEYRA_DATA_DIR`)
- `agent.fast_path` — allowlist команд умного дома (выкл. по умолчанию; публикует `home.*`; multi-client e2e — Этап 3+)
- Слои в `server/config/` — полные ключи в `docs/config-keys.md`:
  - `llm.yaml` — по ролям **`talk_model`**, **`brain_model`**, **`memory_model`**, **`vision_model`** с **`provider`**; провайдеры — **`llm.providers.<name>`**. Без top-level `BACKEND` / `openrouter:` / `vision:`.
  - `memory.yaml`, `voice.yaml`, `agent.yaml`, `modules.yaml`, `runtime.yaml`

## Вынесено из корневого файла

- `discord` → `server/modules/discord/config.yaml`
- `api`, `dashboard` → `server/config/server.yaml` (секции `api:` и `dashboard:`)
- Прочие настройки плагинов → `server/modules/<id>/config.yaml`

## Запрещено хранить в yaml

- API keys и токены. Используйте `server/.env`.
