# Справочник `server/config.yaml`

`server/config.yaml` содержит только короткий корневой runtime-конфиг ядра (assistant, paths, указатели на слои).

## Ключевые секции

- `assistant` — `name`, `persona_path` / `appearance_path` (persona pack), `system_prompt` как fallback
- `paths.data_dir` — корень runtime-данных (default `server/data` от корня репо; override — `NEYRA_DATA_DIR`)
- `agent.fast_path` — allowlist команд умного дома (выкл. по умолчанию; публикует `home.*`; multi-client e2e — Этап 3+)
- `agent.conversation_mode` в `server/config/agent.yaml` — глобальный стиль talk-ответов: `default` (persona без изменений), `brief` (кратко), `detailed` (подробно), `technical` (технически), `no_jokes` (без шуток/сарказма). Отсутствующий ключ равнозначен `default`; неизвестные значения и неверные типы отклоняются.
- Слои в `server/config/` — defaults: `server/config/*.example.yaml`; полный список ключей: `python server/scripts/regen_config_keys_md.py` из корня репозитория (вывод в stdout):
  - `llm.yaml` — по ролям **`talk_model`**, **`brain_model`**, **`memory_model`**, **`vision_model`** с **`provider`**; провайдеры — **`llm.providers.<name>`**. Без top-level `BACKEND` / `openrouter:` / `vision:`.
  - `memory.yaml`, `voice.yaml`, `agent.yaml`, `modules.yaml`, `runtime.yaml`

## Вынесено из корневого файла

- `discord` → `server/modules/discord/config.yaml`
- `api`, `dashboard` → `server/config/server.yaml` (секции `api:` и `dashboard:`)
- Прочие настройки плагинов → `server/modules/<id>/config.yaml`

## Запрещено хранить в yaml

- API keys и токены. Используйте `server/.env`.

## Генерация плагинов и фоновые записи

Необязательный `llm.coder_model: {provider: aihope, model: your-model}` в
`config/llm.yaml` выбирает модель PluginBuilder. Без блока используется
`brain_model` целиком; coder без provider наследует провайдера brain. Endpoint,
headers и ключ берутся из общей конфигурации провайдера. Автоматического ухода
в OpenRouter нет. Изменение этого файла требует перезапуска.

`memory.diary_after_turn: true` создаёт одну фоновую запись после успешной пары
сообщений. Она заменяет прежние `llm.async_reflection.*` и diary-опции
`memory.emotional_layer`: эти ключи deprecated и игнорируются, дублирующие
планировщики удалены. Остались активны emotional_layer.enabled и ltm_emotion_*
для необязательных метаданных тона LTM. История процесса
разделена по владельцу и каналу; diary сохраняется в SQLite с той же областью.
Legacy `assistant.persona_in_brain` и `persona_brain_max_chars` игнорируются:
persona принадлежит talk. Streaming usage включается только для поддерживающего
шлюза: `llm.providers.<name>.capabilities.supports_stream_usage: true`.

## Переключение режима общения

Файл `server/config/agent.yaml`:

```yaml
agent:
  conversation_mode: technical
```

Изменение файла применяется после перезапуска. Для переключения без рестарта отправьте с admin Bearer или dashboard-сессией `POST /v1/config/update`:

```json
{"updates": {"agent.conversation_mode": "no_jokes"}}
```

API сохраняет значение в слой `config/agent.yaml` и возвращает его через `GET /v1/config/runtime`. Режим фиксируется при начале хода: сохранение влияет на следующие ходы, не меняя уже начатый ответ или его повторы. Пересборка LLM-клиентов не нужна. В веб-панели: Настройки → Речь → Режим общения → Сохранить.

Хинт действует в обычном и потоковом чате, при повторе после переполнения контекста и при перефразировании ответа. Он имеет приоритет над стилем persona; brain/tools и правила работы с памятью не меняются. Режим полного текста песни имеет приоритет над краткостью. Это инструкция модели, а не гарантия формулировки; видимую длину по-прежнему задаёт `llm.talk_model.reply_max_tokens` (для длинных подробных ответов увеличьте его явно). Для Responses `max_output_tokens` равен этому лимиту плюс `llm.talk_model.output_token_headroom` (по умолчанию 2048), чтобы рассуждение и план не съедали ответ. Абсолютный потолок — `llm.talk_model.max_output_tokens`. Повторы ожидания первого токена делят `llm.talk_model.turn_timeout_seconds`; если ключ не задан, берётся `timeout_seconds`.
