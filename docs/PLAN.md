# PLAN.md — Neyra-AIAssist

> Глобальный план развития от текущего стенда к локальному серверу и клиентскому приложению управления. Формулировка темы, объект, предмет и цель ВКР фиксируются без изменений.

## 0. Контекст ВКР и критерий защиты


| Что                  | Значение                                                                                                                                                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Тема ВКР**         | «Разработка прототипа модульной информационной системы персонального ИИ-ассистента с локальным сервером и клиентским приложением управления»                                                                                             |
| **Объект**           | модульная информационная система персонального ИИ-ассистента                                                                                                                                                                             |
| **Предмет**          | архитектура, программные компоненты и способы взаимодействия локального сервера ИИ-ассистента с клиентским приложением управления                                                                                                        |
| **Цель**             | разработать прототип модульной информационной системы персонального ИИ-ассистента с локальным сервером и клиентским приложением управления                                                                                               |
| **Минимум к защите** | сервер, Windows-клиент Tauri 2 + React + TypeScript, подключение по адресу и токену, чат со streaming-ответом, статус health/modules/models/API, включение/выключение модуля, мягкий рестарт, минимум один рабочий модуль, схемы и тесты |


Установщик сервера остаётся в backlog. Для демонстрации сервера достаточно Docker Compose или systemd на домашнем сервере и `run_neyra.bat` на Windows. Установщик клиента NSIS и автообновление входят в Этап 3, но не являются минимумом защиты: для защиты достаточно собранного `setup.exe`.

## 1. Архитектурные принципы

- Один Neyra Server содержит ядро, память, LLM-маршрутизацию, STT/TTS, инструменты, модули и Event Bus.
- Клиент — тонкое окно управления: он не оркестрирует агента, не хранит память и не принимает серверные решения.
- Вся серверная бизнес-логика и состояние находятся на сервере; клиент получает их через Control API.
- Клиент собирается со своим UI, стилями, иконками, шрифтами и звуками и открывается без сервера с состоянием «сервер недоступен».
- На сервере остаются чат, история, память, конфиги, промпты, модули, логи, статус и TTS; клиент только воспроизводит полученное аудио.
- `core/` не изменять без необходимости, которую нельзя закрыть модулем, Internal API или Event Bus.
- Конфигурация разделяется по слоям; секреты не коммитятся.
- Dev MCP отделяется от runtime-поставки.



## 1a. Аудит

Аудит завершён; исходная карта сохранена в истории Git. Актуальная структура, пути данных и правила конфигурации приведены в §1b/§1c, общие руководства — в `docs/en/` и `docs/ru/`.

### Готово, когда

- [x] Исходные каталоги и направления переноса проверены; итоговая карта приведена в §1b.
- [x] Отдельно учтены `.env`, YAML-конфиги, `memory/`, `logs/` и Lavalink JAR, которые Git не переносит.
- [x] Зафиксированы реальные пути `interfaces/discord/`, `interfaces/internal_api/`, `interfaces/local_voice/`, `interfaces/000EXAMPLE/` и `tools/mcp_server/`.
- [x] Тема, объект, предмет и цель ВКР сверены с исходным планом и не изменены.



## 1b. Атомарная перестройка server/client/devtools

Этап выполняется целиком в одной рабочей ветке и без legacy-алиасов.

### Целевая структура

```text
server/
  core/
  modules/
  dashboard/
  config/
  scripts/
  prompts/
  sounds/
  models/
  data/
client/
devtools/
docs/
```


| Сейчас                              | После 1b                                   | Действие                                                                                         |
| ----------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `core/`                             | `server/core/`                             | перенести серверное ядро                                                                         |
| `interfaces/`                       | `server/modules/`                          | перенести серверные модули и обновить imports                                                    |
| `frontend/`                         | `server/dashboard/`                        | перенести существующий серверный dashboard                                                       |
| `scripts/`                          | `server/scripts/`                          | перенести серверные проверки и утилиты                                                           |
| `prompts/`                          | `server/prompts/`                          | перенести серверные prompt/persona-файлы                                                         |
| `sounds/`                           | `server/sounds/`                           | перенести серверные звуки; UI-звуки клиента входят в client bundle                               |
| `models/`                           | `server/models/` или внешний runtime cache | классифицировать; кэш не включать в package без необходимости                                    |
| `tools/mcp_server/`                 | `devtools/mcp_server/`                     | переместить dev-only MCP, не включать в server/client package                                    |
| `memory/`                           | `server/data/memory/`                      | SQLite Hub, Chroma и пользовательская память; перенос только migration helper с проверкой hashes |
| `logs/`                             | `server/logs/`                             | runtime logs; перенос migration helper с проверкой                                               |
| отсутствующий продуктовый `client/` | `client/`                                  | создать отдельный Tauri-проект, не переиспользовать `frontend/`                                  |
| корневой `PLAN.md`                  | удалить                                    | канон уже в `docs/PLAN.md`; дубликат не оставлять                                                |


Путь к данным читается из `paths.data_dir` (default: `server/data` относительно корня репозитория или `./data` при работе из `server/`), override — `NEYRA_DATA_DIR`. После 1b физический default указывает на `server/data/`.

До любых операций нужен полный внешний backup проекта и runtime-данных. Скрипт `server/scripts/migrate_runtime_layout.py`: сначала `--dry-run` (таблица), затем прогон с hash/size и `--report-memory` (Hub/Chroma). Переносит root `config.yaml`, `.env`, module configs, `memory/` → `server/data/memory/`, `logs/` → `server/logs/`, опционально legacy `Lavalink.jar` (или `fetch_lavalink.py`). Без `--force` target не перезаписывается; source удаляется только с `--remove-source` / `--cleanup-legacy-root`. Прогоны и приёмка зафиксированы в PR #14.

После переноса `main.py` все entrypoints (`run_neyra.bat`, `run_neyra.sh`, Windows launcher, Docker, `scripts/healthcheck.py`, `scripts/invoke_plugin.py`) запускаются из `server/` или задают `PYTHONPATH=server`.

Упаковка пакетов внутри `core/` (`core.memory`, `core.plugins`, …) выполнена отдельным этапом. Этап **1b этого PLAN** относится к перестройке `server/` / `client/` / `devtools/`.

### Готово, когда

- [x] Выполнен полный backup до `git mv` и до миграции ignored-файлов.
- [x] Серверные файлы перенесены в `server/`, создан отдельный `client/`, dev MCP перенесён в `devtools/mcp_server/`.
- [x] Ignored-конфиги, `.env`, `memory/` → `server/data/memory/`, `logs/` → `server/logs/` перенесены; Lavalink JAR — `.gitignore` + `fetch_lavalink.py` (опционально FILE move в migrate).
- [x] SQLite Hub, Chroma и пользовательская память доступны без потери данных по новому default path `server/data/`.
- [x] Все entrypoints работают из `server/` или через `PYTHONPATH=server`.
- [x] Нет дубликатов runtime в корне (`.env`, `config.yaml`, `memory/`, `logs/`); канон только под `server/`.
- [x] Нет переходных алиасов и fallback-импортов на старую структуру (loader/builder/MCP только `server/modules/`).
- [x] Поиск по коду, скриптам, Docker и README (кроме исторической карты в этом PLAN) не находит `interfaces/`, `frontend/`, `tools/mcp_server` — проверка: `python server/scripts/verify_stage_1b.py`.
- [x] Docker: тонкий `docker-compose.yml` в корне (include), реализация в `server/` (`Dockerfile`, `docker-compose.yml`, `.dockerignore`).
- [x] `Lavalink.jar` не в git; локально через `server/scripts/fetch_lavalink.py` (см. `.gitignore`).
- [x] Миграция памяти на `server/data/memory/` с hash/size check в `migrate_runtime_layout.py`; Hub/Chroma доступны после переноса.
- [x] Запущены compileall, healthcheck и smoke локально; CI — `.github/workflows/ci-verify.yml` (job Layout & tree); детали в PR #14.
- [x] CI `Stage 1b verify` зелёный на head PR.
- [x] Политика переноса memory/logs подтверждена владельцем в PR #14.
- [x] `paths.data_dir` / `NEYRA_DATA_DIR` доходят до Hub/Chroma через `apply_resolved_memory_paths` (`server/core/runtime/paths.py`).
- [x] Корневой `PLAN.md` удалён; канон только `docs/PLAN.md`.



## 1c. Слои конфигурации и схема

- `server/config.yaml` — короткий корневой конфиг, включая `assistant.*` и `paths.data_dir`.
- `server/config/llm.yaml` — провайдеры, профили и роли моделей.
- `server/config/agent.yaml` — agent, prompt/runtime и vision settings.
- `server/config/memory.yaml` — память, external storage и backup.
- `server/config/voice.yaml` — voice providers и STT/TTS.
- `server/config/modules.yaml` — включение модулей и MCP allowlist.
- `server/config/runtime.yaml` — logging и runtime settings.
- `server/config/server.yaml` — Internal API, bind host, port и dashboard settings.
- `server/.env` — только секреты; `HF_TOKEN` и `HUGGING_FACE_HUB_TOKEN` optional и закомментированы в example.

В начале 1c групповые записи inventory заменяются подробной таблицей: один ключ на строку, точный тип, default, источник чтения, target file, env override и compatibility status. До изменения общего loader проверяется фактический consumer и merge-поведение `server/modules/local_voice/config.yaml`.

### Готово, когда

- [x] `server/config.yaml` не содержит дублирующей глубокой конфигурации и сохраняет совместимые defaults.
- [x] Типы и defaults заданы в `server/config/*.example.yaml` и schema; layering/override описаны в §1c и `docs/{en,ru}/setup/config-reference.md`. Полный список ключей выводит `python server/scripts/regen_config_keys_md.py`, без создания отдельного документа.
- [x] Loader валидирует схему до запуска и сохраняет понятные ошибки.
- [x] `paths.data_dir` и `NEYRA_DATA_DIR` проверены на `server/data` после переноса memory/logs.
- [x] Consumer и merge-поведение `server/modules/local_voice/config.yaml` проверены; поведение voice не исчезает молча (`verify_stage_1c.py`).
- [x] Legacy env aliases поддержаны с warning once (`YANDEX_ID_KEY`, `HUGGING_FACE_HUB_TOKEN`).



## 1d. Dual LLM backend (AIHope + OpenRouter)

Цель: полноценный AIHope (OpenAI-compatible) как основной бэкенд для brain/memory/vision и dual-role: talk на OpenRouter (бесплатный Qwen с меньшей цензурой).

### Объём

- Пресет `aihope` → `https://aihope.fun/v1`; роли под `llm.talk_model` / `llm.brain_model` / … с полем `provider` (без `BACKEND` и без обёртки `openrouter:`).
- Баланс AIHope + dual `/v1/llm/balance` (503 если нет ключей).
- Ключи только из `.env` (`AIHOPE_API_KEY` / `OPENROUTER_API_KEY`); в yaml нет `api_key` / `context_window` / глобального `max_tokens`.
- Example: talk=`qwen/qwen3.8-27b:free`@openrouter, brain=`gpt-6-luna`@aihope.
- Offline `verify_stage_1d.py` + CI; backlog: секреты → системный env ОС.



### Готово, когда

- [x] Dual-backend: talk и brain могут ходить на разные провайдеры с разными ключами/base_url.
- [x] AIHope chat/completions через LangChain; helpers для models/balance/images/responses/messages.
- [x] `/v1/llm/balance` отдаёт usage для активных провайдеров (openrouter и/или aihope).
- [x] `verify_stage_1d.py` и CI зелёные; локальный `llm.yaml` на dual-схеме.

**Конфиг (без legacy):** канон только `llm.*` ролей + `llm.providers.*`. Top-level `BACKEND` / `openrouter:` / `vision:` и пути `openrouter.*` в `POST /v1/config` **не** поддерживаются (нет алиасов / dual-read) — клиенты пишут `llm.talk_model` / `llm.brain_model` / ….

## 2. Единый Neyra API (core)

Этап 2 делает HTTP/WS control plane частью ядра: пакет `[server/core/api/](../server/core/api/)`, конфиг `api:` в `[server/config/server.yaml](../server/config/server.example.yaml)`. Отдельного второго API и модуля `modules/internal_api/` нет.

### Объём (Wave 1)

- чат со streaming через **WebSocket** (`/v1/ws/chat`); SSE — backlog;
- health, meta (`/v1/meta`), модели (`/v1/llm/models`), модули/плагины;
- мягкий рестарт: `POST /v1/system/restart` (maint+);
- токены `API_TOKEN` / `API_VIEWER_TOKEN` / `API_MAINT_TOKEN`; bind default localhost; `API_BIND_HOST` для LAN/Docker;
- публичный URL: `api.public_base_url` + `api.public_path_prefix` (пример `https://neyra.owyx.site` + `/api`);
- аудит изменяющих действий.

Вторая очередь (Wave 2): GET/PUT конфигурации с schema validation, hot reload и rollback; промпты; логи; **start/stop/reload плагинов in-process** (в Wave 1 → HTTP 501, использовать `POST /v1/system/restart`).

### Готово, когда

- [x] API в `server/core/api` (не module); конфиг `api:` + public URL.
- [x] Versioned contract: meta/models/health enrichment; docs sync.
- [x] Streaming WebSocket: auth как REST; **чат = admin** (как `POST /v1/chat`); reconnect = новый сокет.
- [x] Viewer не мутирует; soft restart без silent plugin stubs; fail-closed bind без токенов.
- [x] localhost default; LAN через явный bind + tokens / proxy recipe.
- [x] `verify_stage_2_api.py` + CI (`CI verify` / HTTP API & auth).
- [x] Ручной смоук: `/docs`, `GET /v1/meta` (`public_url` / `dashboard_url`).
- [x] `anon` на loopback без токенов — осознанная политика Wave 1 (документировано; non-loopback без токенов запрещён).



## 3. Веб + ядро, затем Windows-клиент

Этап 3 делится на две части: сначала допиливаем **веб-панель и поведение Нейры**, потом отдельным подэтапом — полноценный Windows-клиент.

### 3a. Веб-панель и ядро Нейры (сейчас)

Контроль PR #27 подтвердил исправления потокового talk-контекста и retry,
режимов диалога, model trace, redaction/retry, memory hub/SQLite dedupe,
секретов PluginBuilder, MCP/web-search/GIF regressions и dashboard auth.
Полное закрытие acceptance остаётся условным: нужен зелёный CI и отдельная
live-приёмка провайдеров, Discord, WebSearch, webhook и контейнера; эти вызовы
в рамках PR не выполнялись.

`server/dashboard/` — ops/admin control plane (статус, модули, память, система, вебхуки, настройки, docs), пока нет десктоп-клиента. `client/` остаётся самостоятельным приложением со своим UI; исходники dashboard туда не копируются. Возможный общий пакет API-контрактов требует отдельного решения. UI сейчас на русском; полная ru/en-локализация открыта в §14.

**Люди (память):** account-first карточки, accounts/aliases и свободные `person_facts`; анкетных полей нет (§7). CRUD в дашборде; агент обновляет через tools.

Модули в вебе: действия по `lifecycle` (resident → PATCH enabled **с авто soft-restart ядра**; on_demand → invoke; общий enable/config). В дашборде модуля: вкладки «Управление / Конфиги / Логи», загрузка `.zip` (`POST /v1/plugins/upload`), удаление (`discord` защищён), правка конфиг-файлов (`/v1/plugins/{id}/files`), хвост логов (`/v1/logs`). Scaffold/export модулей — полигон для 3b (shared UI → desktop Monaco): код-редактор — во второй очереди клиента.

**Discord / ответ модели (закрывать в 3a):**
- [x] Сохранять переносы строк в user-facing reply (не схлопывать `\s+` в одну строку).
- [x] Brain-native vision: talk тоже видит картинку, если talk = VL-модель; иначе caption для talk.
- [x] Нормализованный Discord-контекст в payload до LLM: `current_user`, `channel`, `guild`, `message`, `addressed_to_bot`, `response_target`. #27: типизированный объект до обработки текста, brain/talk/vision/retry, REST/WS; offline-проверки ID/DM/guild/reference.
- [x] Режимы общения (кратко / подробно / техн. / без шуток) — `agent.conversation_mode`, проверка/сохранение через admin API, Settings Select, общий talk prompt и непротиворечивые повторы. #27: локальная UI → API → pipeline приёмка; настоящие LLM проверяются отдельно ниже.
- [x] Честность о модели: #27 — отчёт по каждому ходу talk/brain/vision в REST/WS, SQLite metadata, Event Bus, логах и Status; `/model` для собственного последнего хода в канале. Настроенное и сообщённое провайдером разделены; отсутствие metadata не угадывается.

**Бэклог идей из живого чата (после 3a-блокеров, лёгкие — раньше):**
- Память без бардака: временный контекст / факты / устаревшее; confirm на sensitive; одна команда «забудь/поправь».
- Персонализация и профили людей (предпочтения тона, кто любит троллинг).
- Авто-выбор инструментов + краткий отчёт «что сделала».
- Устойчивость к неоднозначности: один уточняющий вопрос вместо веера догадок.
- Самопроверка ответа (противоречия / ссылки) перед send — опционально.

### Веб-панель v2 и hardening API

Чекбоксы — только по факту merge/приёмки. **#25** (T0–B5 + D0 foundations) смержен.
Ops Console D0–D8 смержен в **#26**. Текущий follow-up: **#27** — auth hardening, режимы общения, нормализованный Discord-контекст и отчёт о моделях.

- [x] **T0** — `server/tests/` + pytest, `requirements-dev.txt`, CI jobs pytest/dashboard/secrets, `typecheck`, README ключ ≥32 (#25)
- [x] **B1** — ошибки без `str(e)`, `trace_id`, redaction, anon за прокси, security headers, docs gate (#25)
- [x] **B2** — pydantic bodies (`extra=forbid`), timeouts, RPM/429, webhook dedup (#25)
- [x] **B3** — атомарные миграции, транзакции, индексы, health live/ready/history (#25)
- [x] **B4** — sqlite backup API, двухфазный restore, drill, тесты на реальной SQLite (#25)
- [x] **B5** — роли viewer без PII, rotate/logout-all, PBKDF2 600k, матрица ролей (#25)
- [x] **D0** — Tailwind/токены/шрифты/shadcn/react-query/api client/vitest/`/__ui` (#25 + хвосты в follow-up)
- [x] **D1** — shell, ⌘K, theme, 404, robots, favicons, Playwright smoke (в follow-up PR)
- [x] **D2** — Status: react-query, health history, audit recent, RestartProgress (в follow-up PR)
- [x] **D3** — Modules + LogViewer v2 (virtual, level colors, filters) (в follow-up PR)
- [x] **D4** — Memory: KPI, people search, merge side-by-side, wipe zone (в follow-up PR)
- [x] **D5** — System: LogViewer v2, health checks, backups + RestartProgress on restore (в follow-up PR)
- [x] **D6** — Webhooks: RHF+zod outbound form, Switch (в follow-up PR)
- [x] **D7** — Settings/access/docs по DESIGN (в follow-up PR)
- [x] **D8** — a11y/polish, react-doctor, чеклисты 5.1/5.2 (в follow-up PR)

### Готово, когда (3a)

**Локальная приёмка #27 (без настоящих LLM/Discord и без деплоя):**
- [x] Rewrite prompt не содержит противоречивых требований краткости/Markdown.
- [x] Режим общения выбирается и сохраняется в Settings; UI → API → следующий prompt проверены.
- [x] Discord-контекст проходит brain/talk/vision и повторы; ID определяют область памяти.
- [x] Отчёт по ходу доступен в REST/WS, metadata, Event Bus, Status и приватной `/model`; тесты отсутствующего model ID, ошибок, отмены, retries и параллельных ходов.
- [x] Локальный backend с временными данными и заглушками покрыт desktop/mobile browser-тестами ops-сценариев (8 сценариев, обе темы). Исправлены читаемость светлой темы и независимость моделей от ошибки баланса.
- [x] AR-7…AR-11: тесты/E2E игнорируют унаследованный `NEYRA_DATA_DIR`; Discord-метаданные без текста сообщения идут в human-role, упоминания ограничены 10 и блок убирается при overflow-retry; REST-отмена отмечена `cancelled`; ошибки config/update не раскрывают исключения; произвольные Discord-пинги запрещены. Целевые offline-регрессии пройдены.
- [x] AR-12: описание #27 отделяет live-приёмку от Tasks и явно указывает добавление §10 относительно main (только план, без реализации Agent loop).
- [x] Сохранена совместимость подготовки хода без необязательного Discord-поля; повторно пройдены все 10 отдельных offline-скриптов LLM/memory CI и 127 server-тестов.

**Отдельная live-приёмка (не входит в локальную реализацию #27):**
- [ ] Настоящие модели соблюдают режимы общения и vision-инструкции.
- [ ] Настоящий Discord подтверждает контекст, готовые ответы без черновика/редактирования, `/model` и lifecycle модулей на стенде.

- [x] Веб-панель закрывает проверенные ops-сценарии без десктопа: локальная приёмка #27 — статус, module toggle, память, настройки, backup и запрос soft restart (остановка процесса на тестовом стенде заглушена). Подтверждение результата invoke/health модуля остаётся открытым в §4.
- [ ] Discord: зрение + структурированные ответы стабильны на стенде.
- [x] Нормализованный Discord-контекст в payload (не парсинг подписи), offline-приёмка #27.
- [x] Discord отправляет только готовый финальный результат ядра: без символа `▌`, typing-запросов и промежуточных edit. Внутренний agent.chat_stream сохраняет first-token timeout и context retry; token chunks не публикуются, генератор закрывается явно. Длинный ответ/lyrics делится после генерации; автор/канал/vision и Event Bus сохранены. Старые stream_output_mode/stream_edit_interval игнорируются. 13 регрессий адаптера проверяют ожидание готовности, reply/send, длинные ответы/lyrics, исключение/error chunk/отсутствие done, отмену, ошибку отправки и настоящий offline-повтор ядра после overflow с одним Discord-ответом. AR-10 дополнительно закрывает утечку текста ошибок в ядре/Discord/WS: фиксированные фразы выбираются по коду, произвольный text и public-флаг не принимаются. Ещё шесть регрессий настоящего ядра/WS проверяют brain/talk/overflow retry и сохранение диагностики. Полный pytest 357, compileall, validator 72/3/3 и 14 stage/offline scripts прошли. Live-проверку выполняет пользователь после деплоя.
- [x] Модули: browser toggle проверен в #27; результат invoke/health не подтверждён и остаётся открытым в §4. Scaffold шаблона остаётся опциональным backlog.

### Открытые проверки багов на стенде

Локальные исправления и регрессии не закрывают внешние сбои и приёмку настоящих интеграций. Исходные логи и подробные отчёты сохранены в истории Git; приватные данные в документацию не переносятся.

- [ ] **BUG-01, coder/OpenRouter 404:** проверить успешное создание тестового плагина через настроенный coder/brain и причину прежнего 404. Выбор провайдера и безопасные tool errors исправлены локально.
- [ ] **BUG-02, browsermcp:** проверить реальный executable, command/args и окружение. Повторный reconnect при отсутствующем executable остановлен локально; отсутствующий путь по исходному логу неизвестен.
- [ ] **BUG-03, WebSearch:** сверить доступные backends установленной DDGS; проверить, что fallback не подписан запрошенным отсутствующим движком. Обработка ошибок исправлена, фактический источник выдачи ещё не подтверждён.
- [ ] **BUG-04, streaming timeout:** проверить first-token/общий timeout, отмену и задержки провайдера; Discord должен получить безопасное сообщение об отказе. До публичного текста допустим ограниченный retry, после него replay запрещён.
- [ ] **BUG-05, working_memory 502:** проверить сохранение предыдущего snapshot, восстановление обновлений и отсутствие блокировки чата длительным фоновым retry; сверить trace/usage без тела ответа провайдера. Внешняя причина 502 не исправляется локальными тестами.
- [ ] **BUG-06, приватность WebSearch:** проверить redaction в фактических логах приложения, библиотек и reverse proxy; уточнить причину выбора поиска для разговорной реплики. Локально текст query/URL убран; тестировать только синтетическими данными.
- [ ] **BUG-07/08, Discord GIF и готовые ответы:** проверить Tenor/Discord CDN, embed/attachment без play-намерения, неподдерживаемую ссылку до подключения voice и обычный YouTube. GIF-routing исправлен; бот отправляет финальный текст без курсора/typing/edit. Настоящий Discord ещё не проверен.
- [ ] **BUG-09, пустой Luna Responses:** провайдеру выяснить два ответа 200/completed без текста и с output_tokens=0 (70.62/34.28 s); контрольные повторы прошли, устойчивое исправление не подтверждено. Runtime допускает одну восстановительную попытку до публикации, не продвигает ошибочный ID и записывает обе попытки в trace. Отдельно от GLM: при лимите 128 бюджет уходил в reasoning, при 512 текст появлялся.
- [ ] **BUG-10, pipeline/vision:** подтвердить на настоящих моделях отсутствие private reasoning в ответе/памяти, сохранение фактов brain/vision при overflow и последнего tool result; проверить owner/channel scope image notes. Исправления и отсутствие лишнего brain-native caption-вызова покрыты offline. По старому логу нельзя доказать двойной вызов, потерю сообщений или точную задержку ответа.
- [ ] **BUG-11, дубли людей:** проверить рабочую базу после смены ника, фоновой reflection и ручного merge/undo. Неизвестный ник/ID больше не создаёт карточку; account ID и существующий UUID/аватар сохраняются. Старые дубли автоматически не объединяются.


**Интеграционный прогон текущей рабочей копии (2026-10-15):** предыдущая локальная проверка зафиксировала проходящие `compileall`, Stage 1b/1c и offline memory checks; локальные Stage 1d/2 и pytest оставались ограничены отсутствующими зависимостями. PR CI run `38763988786` до mode fixes выявил `Pytest` (`13 failed, 124 passed`), один hard-fail в offline memory/security smokes и два одинаковых desktop/mobile E2E failure на сценарии сохранения настроек через следующий offline turn; Config layers, HTTP API & auth, Layout & tree и Secrets scan прошли. Mode fixes в рабочей копии исправляют подтверждённую передачу режима в brain/talk prompts и stub-ответ; после них требуется новый CI прогон. Эти результаты не закрывают live-критерии и не меняют открытые BUG/live пункты.

**Финализация после Kilo (2026-10-15):** на `9cb2bed` CI подтвердил 4 pytest failure и 6 зелёных jobs. Исправлены AR-14/15: Discord metadata только в human-role, единый английский маркер, блок удаляется при overflow-retry. AR-19: убран путь локального хоста из progress. AR-20: глобальный admin-only контракт удаления diary/journal явно описан и проверен; фильтры хранилища не являются пользовательской авторизацией API. Локально в проектном `.venv`: 142 pytest-теста и все 14 stage/offline-скриптов проходят. Актуальный CI проверяется после push отдельно.

Остатки исходного задания реализованы в продолжении PR #27: coder следует конфигурации, scoped diary подключён к pipeline, три секции памяти и отдельный журнал доступны в dashboard, фоновые jobs имеют собственные отчёты. Контракты и ограничения приведены в §12–14. Live-приёмка остаётся открытой; голос, Agent loop, Windows и вынос текстов §14 сюда не входят.

### 3b. Клиент для Windows и Linux — после серверной части

Клиент — **Tauri 2 + React + TypeScript**, тонкое окно управления сервером для Windows и Linux. Самостоятельный UI в `client/`, без переноса исходников dashboard. Реализация отложена до завершения согласованной серверной части; сейчас только scaffold. Windows остаётся минимумом защиты из §0, Linux добавлен пользователем в продуктовый scope 2026-10-16.

#### MVP-экраны

- Подключение: адрес сервера и токен; Windows Credential Manager и системное хранилище секретов Linux (адаптер выбрать при реализации), не открытый текст.
- Чат: server-side history и streaming.
- Статус: health, modules, models и API version. Экран называется «Статус», не «Дашборд».
- Модули: список, состояние, включение/выключение и start/stop.

Клиент открывается без сервера и показывает состояние «сервер недоступен». В сборку клиента входят UI, стили, иконки, шрифты и звуки самого приложения. Сервер отдаёт через API чат и историю, память, конфиги, промпты, модули и их состояние, логи и статус. TTS генерирует сервер, клиент только проигрывает аудио.

Локально у клиента хранятся только адрес сервера, токен в системном хранилище секретов, тема, размер окна и кэш последнего статуса. URL сервера — из настроек клиента (в т.ч. публичный домен из §4); frp/прокси **не** часть Этапа 3b.

Вторая очередь клиента: Monaco (промпты/конфиги/модули), логи, настройки приложения, import/export модулей.

#### Сборка и автообновление

- Tauri 2 bundler, NSIS `setup.exe`, `installMode: currentUser`; MSI не нужен.
- Автообновление через `@tauri-apps/plugin-updater`; подпись через `tauri signer generate`.
- Приватный ключ и пароль только в GitHub Secrets: `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
- Публичный ключ в `tauri.conf.json`; endpoint — `latest.json` в GitHub Releases.
- Проверка обновлений при старте и кнопка «Проверить обновления», диалог версии и restart после установки.
- `.github/workflows/client-release.yml` на `windows-latest` через `tauri-apps/tauri-action`, trigger `client-v*`; PR CI делает lint, typecheck и build без релиза.
- Единая версия в `package.json`, `tauri.conf.json` и `Cargo.toml`.
- При подключении клиент проверяет совместимость версии API.
- Сертификат подписи кода для SmartScreen — backlog.

#### Готово, когда (3b)

- [ ] MVP-экраны подключены к Control API и не содержат server-side orchestration.
- [ ] Клиент корректно работает при недоступном сервере.
- [ ] Токен не хранится открытым текстом.
- [ ] Собирается NSIS `setup.exe` для current user.
- [ ] Linux: выбраны форматы поставки, проверены сборка, установка, запуск и безопасное хранение токена; не считать готовым по Windows-сборке.
- [ ] Автообновление и error state проверены на тестовом release.
- [ ] PR CI выполняет lint, typecheck и build; release CI создаёт `latest.json`.
- [ ] Клиент берёт URL сервера из настроек (не hardcoded); корректно работает с опубликованным Control API (см. §4).



## 4. Серверная поставка и модульная эксплуатация

- Docker Compose и systemd — поддерживаемые способы запуска; `run_neyra.bat` — Windows entrypoint.
- Paths/volumes/healthchecks смотрят в `server/`; интеграции — modules через Event Bus и Control API.
- **Публикация под доменом** (frp + edge) — этот этап, не клиентский §3. Детали ops: `docs/ru/ops/api-reverse-proxy.md`.



### Канон публикации

```text
Клиент / браузер
  → https://neyra.owyx.site  (+ wss://…/api/v1/ws/chat)
  → nginx/Caddy на VPS (TLS)
  → frps (HTTP vhost)
  → frpc на домашнем сервере
  → Control API 127.0.0.1:8787
```

Данные (память, `.env`, логи, модели) остаются на **домашнем** сервере; на VPS только proxy + frps. Docker Compose на VPS — запасной стенд, не замена канону. Bind по умолчанию loopback; наружу только через frp. Токены обязательны при внешнем доступе. IP/rate-limit/setup-guard — в security-model / reverse-proxy docs (не дублировать здесь).

Пример `frpc` (секреты не в git): `type=http`, `localPort=8787`, `customDomains=["neyra.owyx.site"]`; `api.public_base_url` + `api.public_path_prefix: /api`.

### Статус стенда

- [x] `/opt/neyra` + systemd `neyra` на домашнем хосте (`127.0.0.1:8787`).
- [x] frpc → frps (VPS сайта) → nginx `neyra.owyx.site` + LE; strip `/api`.
- [x] DNS/Cloudflare; `api.public_base_url=https://neyra.owyx.site`.
- [x] Dashboard gate (session Bearer), public setup-guard, RPM через `resolve_client_ip`.
- [ ] WSS-smoke: `wss://neyra.owyx.site/api/v1/ws/chat`.



### Готово, когда

- [x] Systemd на домашнем хосте; Docker Compose / Windows batch поддерживаются локально.
- [x] Публичный URL без нестандартного порта (`https://neyra.owyx.site`).
- [ ] Runtime data / secrets / модели не попадают в исходный пакет случайно.
- [x] Локальный example enable/disable проверен через настоящий тестовый backend в desktop/mobile E2E. Клик «Вызвать» без проверки ответа не считается подтверждённым invoke; серверный `/v1/health` не подтверждает health отдельного модуля.
- [ ] Подтвердить результат invoke и health хотя бы одного модуля. Текущий E2E проверяет только enable/disable; настоящий resident Discord остаётся в live-приёмке §3a.
- [x] Документированы установка и восстановление после backup: `docs/{en,ru}/setup/quickstart.md`, `docs/{en,ru}/ops/deployment-local.md`, `docs/{en,ru}/ops/deployment-production.md`, `docs/{en,ru}/ops/backup-restore.md`. Offline restore/drill покрыт отдельным скриптом; восстановление целевого хоста ещё не проверено.
- [ ] WSS-smoke по публичному URL зелёный.



## 5. Проверки, безопасность и качество

- Python compileall и unit/integration tests для затронутых серверных частей.
- API auth/role tests, config schema tests, migration dry-run и data preservation check.
- Dev MCP compile и import smoke: из `devtools/mcp_server/` выполнить `python -m compileall -q server.py` и `python -c "import server; assert server.mcp.name == 'neyra-mcp-debug'"`. Import smoke проверяет регистрацию MCP app и не обращается к Control API или секретам.
- Security boundary: localhost default, explicit LAN bind, token roles, audit и отсутствие секретов в логах.
- Тестовая матрица: Windows client/server unavailable, incompatible API version, stream reconnect, module failure и rollback config.



### Готово, когда

- [x] Обязательные серверные/dashboard проверки запускаются из актуальных каталогов: на кодовом срезе `06948c7` CI 7/7, 454 pytest, 46 unit, 18 E2E; локально также пройдены compileall, validator и 14 stage/offline scripts. Клиентские проверки относятся к §3b и пока не реализованы.
- [x] Secrets scan исходников в CI зелёный; `.env`, локальные конфиги, runtime data, логи и приватная persona не включены в коммит.
- [ ] Проверить отсутствие приватных данных в фактических логах приложения/библиотек/reverse proxy на стенде (§3a, BUG-06); локальные redaction-регрессии этот критерий не закрывают.
- [ ] Smoke-путь «server → Control API → client» воспроизводим.
- [ ] На копии production-данных подтвердить сохранность memory, Chroma, SQLite Hub, ignored configs и Lavalink state при обновлении/восстановлении. Временные SQLite и offline backup/restore уже проверены; рабочие данные в этой реализации не изменялись.



## 6. Документация и демонстрация

- README и docs описывают границы server/client/devtools.
- Архитектурная схема показывает Control API, Event Bus, modules, memory и client.
- Demo script покрывает запуск сервера, подключение клиента, streaming chat, status, module toggle и soft restart.
- Отдельно описаны backlog: server installer, SmartScreen certificate, prompt/config editor и полноценный local voice loop.
- [x] Чистка документации 2026-10-18: вне `en/`/`ru/` оставлены только PLAN и VERSION; отдельные аудиты, отчёты и ADR удалены. Открытые проверки BUG-01…11 перенесены в §3a, эксплуатационные границы — в §12. История поставок ведётся в [VERSION.md](VERSION.md), первая запись 0.1.0 пока в разработке.
- [x] AR-18: с отдельного разрешения пользователя исправлены ровно 8 ссылок в `en/`/`ru/`: ключи ведут к examples и stdout-генератору, model trace — к телеметрии в §12. Остальные тексты и структура руководств сохранены; цели ссылок и генератор проверены локально.
- [x] AR-17: регрессии slash-ошибок перенесены в `test_public_chat_errors.py`, скрытого streaming/retry — в `test_pipeline_edge_cases.py`. Сами функции и parametrization не изменены; полный pytest по-прежнему 454 passed, синтаксис и diff проверены.
- [x] AR-19/20: подтверждённая проверка example сужена до enable/disable, invoke/health оставлены открытыми; пути ops-руководств указаны полностью от корня репозитория. Новых тестов или runtime-изменений эта правка не добавляет.
- [x] AR-22: исторические пункты §3 согласованы с §4 — подтверждён только module toggle; invoke/health везде остаются открытыми. Все упоминания invoke в PLAN/VERSION перепроверены.



### Готово, когда

- [x] Пути серверного запуска, конфигов, документации и ресурсов сверены с `server/`, `client/`, `devtools/`; Stage 1b/1c и stdout-генератор прошли. Восемь ссылок EN/RU исправлены в AR-18; запуск целевого стенда остаётся отдельной приёмкой.
- [ ] Demo script укладывается в сценарий защиты.
- [x] Backlog отделён от ближайшего серверного MVP: приоритеты зафиксированы в §15, клиент §3b и Agent loop §10 позже, §9/§11 после ВКР либо при наличии времени. Минимум защиты в §0 сохранён.



## 7. Memory v2 — people / diary / journal

Account-first модель людей без анкетных полей. Реализация в PR #22 вместе с фиксом music intent.

**Cutover (обязательно при деплое):** полный wipe people/diary/journal (и при необходимости LTM) через `POST /v1/memory/wipe` с `confirm: "WIPE"`. Старые досье/анкеты не мигрируются. Migration 002/003 + backfill `meta.discord_ids` → `person_accounts` только чтобы не плодить дубли после частичного апгрейда без wipe; канонический путь — wipe.

### Модель

- **Person card:** opaque `person_id` (по умолчанию `uuid5(platform:platform_user_id)`), `accounts[]` (`platform`, `platform_user_id`, `handle`, `display_name`, `avatar_url?`), `aliases[]`, free-form `facts[]`.
- **Нет** полей профиля first_name / last_name / birth_date / city — только факты из текста.
- **Speaker resolve:** только `platform + platform_user_id` → create+bind. Совпадение handle → merge proposal (админ), не auto-bind. Fuzzy/stem/display_name запрещены.
- **Mentions в тексте:** exact / word-boundary + явный список падежных окончаний (не «Максим»→«макс»).
- **Обращение:** nick / display_name; реальное имя — только если есть факт.
- **Diary:** от первого лица Нейры (чувства). **Journal:** хроника / reflection.
- **Merge:** LLM-tool `propose_people_merge` (pending); apply/reject в дашборде; undo из snapshot (`undone_at`).
- **Wipe API / dashboard:** scopes обязательны + `confirm: "WIPE"`; `sqlite3.backup` (+ Chroma при `ltm`); `server/data/**` в gitignore.
- **Не в этом PR:** суточный embedding-similarity job для кандидатов (memory consolidation) — отдельно после стабилизации proposals UI.

### Готово, когда

- [x] PROFILE_KEYS / анкетная форма убраны из Hub, API, dashboard.
- [x] Account-first resolve + строгие mentions; Discord передаёт id/nick/display/avatar.
- [x] Diary/journal prompts не выдумывают чужие имена.
- [x] propose-only merge + atomic merge/undo (full fact_ids, staled proposals restored) + wipe confirm/backup + proposals UI.
- [x] Offline tests mention/resolve/merge/wipe + music soft-path зелёные; cutover = wipe.



## 7.5. Mood & Relations (серверный MVP реализован локально, live-приёмка открыта)

Две оси, которые влияют друг на друга. Memory v2 уже смержен; §7.5 включён пользователем в ближайшие задачи 2026-10-16. Отдельный серверный этап после PR #28. Контракт, правила и проверки приведены ниже и в §12; diary/emotional_layer сами по себе не заменяют mood/relations.

### Mood (настроение Нейры) — глобальное + краткосрочное

```text
neyra_mood:
  valence:   -1.0 … +1.0   # плохо → хорошо
  arousal:   0.0 … 1.0     # спокойствие → возбуждение
  label:     "спокойная" | "раздражённая" | "игривая" | …
  updated_at
  decay_half_life_hours: 6–12
```

Как меняется: после хода (или раз в N) правила/LLM дают Δvalence/Δarousal; оскорбления/игнор → вниз, комплименты/тепло → вверх; decay к нейтрали; сильные события → diary («сегодня меня задели…»).

Как влияет: ограниченный блок данных о состоянии для brain и talk, отдельно от нейтральных system-инструкций по §12. Persona остаётся сильнее mood и поступает только в talk; brain использует состояние для планирования, не задаёт стиль персонажа. Опциональные voice/reactions — позже. Это состояние Нейры, не привязанное к человеку.

### Relationship — per `person_id`

```text
person_relation:
  person_id
  affinity:   -1.0 … +1.0
  trust:      0.0 … 1.0
  familiarity: 0.0 … 1.0
  tone_bias:  "cold" | "neutral" | "warm" | "playful"
  last_significant_event
  history[]   # короткие записи
```

Таблица `person_relations` (или meta + лог) рядом с people card. Δ по событиям (грубость / ложь / помощь / молчание / извинение); rule-based + редкий LLM-summary раз в сутки. В people context speaker’а — 1–2 строки про affinity; низкий affinity → суше, без личных тем; высокий → больше тепла. Позже: `relation(person_a, person_b)`.

### Стык с Memory v2

```text
Global: neyra_mood  ← все ответы
Per person: person_relation + facts + accounts
diary (чувства) + journal + emotional_layer после хода
```

После успешной пары реплик: ограниченные сигналы → Δmood/Δrelation автора; `memory.diary_after_turn` запускает отдельную фоновую запись дневника. Опциональные WM/emotional LTM metadata работают отдельно и не являются вторым планировщиком diary. Mood/relation доступны следующему ходу; decay учитывает прошедшее время при чтении/ходе, без обязательного daily cron.

Ограничения: persona сильнее mood/relation; даже при affinity=−1 без токсичности вне persona; дашборд: настроение + отношение + reset; LLM не пишет affinity напрямую без лимитов (propose Δ / rules); wipe scopes: `mood` / `relations`.

### MVP (реализован в PR #29)

- [x] Таблицы `neyra_state` (mood) + `person_relations`: migration 6, проверены копия v5, повторная миграция и сохранение памяти.
- [x] После успешного хода: ограниченные явные сигналы → mood + relation автора по account ID. Chat/streaming/fast path, idempotency и reset во время генерации проверены offline.
- [x] `turn_prep`: общий компактный снимок mood/relation для brain и talk, без истории; persona сильнее состояния и поступает только в talk. Context retry и rewrite сохраняют состояние; отключённые части не передаются.
- [x] MemoryScreen: настроение, отношение к выбранному человеку с ID, refresh и подтверждаемые reset mood/одного/всех relations. API viewer/admin, backup перед reset; loading/error/empty, клавиатура/фокус, обе темы и mobile проверены.
- [x] Decay по прошедшему UTC-времени при чтении/ходе, включая первый запрос после рестарта; отдельный cron не нужен. Полупериоды: mood 8 часов, relations 30 дней; диапазоны и откат часов проверены.
- [x] AR #29: affect IO/ожидание lock вне event loop, уникальные неперезаписываемые backup, скользящий часовой бюджет автора 0.2 на ось, TTL ledger 30 дней, дополнительные словоформы и полный аудит reset. Регрессии включены.
- [x] Settings → «Поведение»: 15 строгих boolean-переключателей, независимые mood/relations с сохранением данных, сохранение/перезагрузка/отмена/ошибка, явные требования к рестарту. Defaults и правила применения приведены в §12, «Настройки и эксплуатационные границы».
- [ ] Live: проверить MCP и фоновые расписания после пользовательского рестарта; локальное сохранение флагов не заменяет приёмку этих интеграций.

- [ ] Live: проверить влияние состояния на реальный talk и соблюдение persona. Brain получает те же данные состояния для анализа, но не переписывает persona или ответ talk; это разделение, Discord-авторов, конкурентные ходы, рестарт и reset проверяет пользователь на стенде.

Потом: расширенная история событий и контекстные сигналы, voice/TTS bias, person↔person, явный ролевой «испортить отношения». MVP хранит последние 20 кодов сигналов без текста.



## 8. Постзащитное развитие

- Установщик сервера для Windows/Linux.
- Сертификат подписи клиента для SmartScreen.
- Редактор промптов и конфигов, логи и расширенные настройки клиента.
- Полный local voice loop и дополнительные player integrations.
- Расширенный MCP marketplace/allowlist и production deployment hardening.
- **Обезличивание (AI Assist):** персона только из `assistant.*` + `prompts/persona.md`; ребренд репо/`neyra`-slug — отдельно после Stage 2, не блокер.
- **Desktop / workspace модуль** — см. §9 (после ВКР; не в MVP защиты).



### Готово, когда

- [ ] Каждая post-defense функция имеет отдельный issue/design и не блокирует MVP.
- [ ] Backward compatibility и миграция данных определены до релиза.



## 9. Desktop / workspace модуль (после ВКР)

Идеи «стола» для Нейры: файлы, терминал, окна, позже — лёгкие игры на GPU MiniPC. **Не входит в MVP защиты** (§0 / §3–§6). Код не начинать до отдельного design/issue после защиты. Не заменять `core/` готовым агентом (Hermes / Herald-OS и т.п.) — только свой модуль.

### Архитектура

- Модуль `server/modules/desktop` (или `workspace`): руки и стол; ядро остаётся мозгом (память, LLM, Event Bus, Control API).
- Действия — через Event Bus и plugin invoke / Control API, без оркестрации в клиенте.
- **Гибрид (выбранный путь):**
  1. **Phase A — sandbox:** своя FS под `server/data/desktop/`, shell в jail/Docker, таймауты и лимиты ресурсов.
  2. **Phase B — host surface:** окна / computer-use / запуск приложений и игр на GPU MiniPC только по allowlist; опасные действия — с confirm.

### Слои (идеи)

- `files` — дерево workspace.
- `shell` — команды в песочнице.
- `session` — что «открыто», состояние сессии.
- Позже: `display` (обзор стола), `apps` / games на хосте.

### Не сейчас

- Полный GUI десктопа в дашборде / клиенте на этапах 2–3b.
- Игры и computer-use до стабилизации sandbox.
- Перенос оркестрации на внешний agent runtime.

### Готово, когда (только план)

- [x] §9 записан в PLAN; реализация отложена до post-defense design.
- [ ] Отдельный design/issue перед первым кодом модуля.
- [ ] Phase A (sandbox files + shell) описан с границами безопасности до merge в `modules/`.
## 10. Agent loop: качество ответов и фоновая память (только план)

Идея: вместо одного большого вызова модели Нейра для сложных задач работает в цикле: сама строит следующий шаг, проверяет результат и решает, готово ли. Цикл улучшает качество, а не скорость (каждая итерация это ещё один вызов модели), поэтому через него идёт не всё.

### Слои

- **Роутер на входе.** Простые реплики отвечаются сразу одним вызовом, сложные (многошаговые, с поиском, с инструментами) уходят в цикл. Задержка на коротких сообщениях не растёт.
- **Цикл для сложного.** План, затем шаги, затем самопроверка и ответ. Лимиты: максимум итераций, бюджет токенов, явное условие остановки. Шаги цикла публикуются в Event Bus и видны в дашборде.
- **Подтягивание контекста.** Перед ответом цикл сам решает, что достать из Memory Hub (точечный retrieval), а не грузит всё подряд.
- **Фоновая память.** После диалога отдельный проход без спешки решает, что запомнить, сжимает и сливает дубли, помечает устаревшее. Пользователь его не ждёт. Стыкуется с §7 Memory v2.

### Не сейчас

- Реализация до стабилизации §7 и §7.5.
- Сложные мультиагентные схемы.

### Готово, когда (только план)

- [x] §10 записан в PLAN.
- [ ] Отдельный design/issue: критерии роутера, лимиты цикла, формат событий.
- [ ] MVP: роутер + фоновый проход памяти, цикл для сложного вторым шагом.

## 11. Голос в Discord (схема из двух ботов)

**Отложено после ВКР либо при наличии времени (уточнение 2026-10-16).** Второй бот и голосовой спайк не входят в ближайшую серверную очередь.

- **Бот 1, Нейра:** заходит в войс, слушает через `discord-ext-voice-recv` и отвечает голосом. Для приёма DAVE E2EE ставим voice-recv из ветки PR #65 или #58 с `DaveSession` из discord.py, не из pip.
- **Бот 2, музыка:** текущий Lavalink (`server/modules/discord/music.py`). Отдельный бот нужен, потому что discord.py допускает один voice client на гильдию для каждого бота.
- **Пайплайн:** Silero VAD + определение конца фразы по образцу `MCKRUZ/openclaw-voice`; STT/TTS на сервере через OpenAI-совместимые `/v1/audio/transcriptions` и `/v1/audio/speech`; LLM через текущий бэкенд.
- **Сверка:** `abishop1990/discord-ai-voice` как пример приёма звука с DAVE.
- **Риски:** поддержка DAVE на приёме официально не смёрджена; у openclaw-voice нет лицензии, поэтому берём идеи, не код.

### Первый шаг

- [ ] Спайк: Нейра заходит в войс с DAVE и сохраняет полученный звук в WAV. Если приём не работает, остальные части не начинаем.
- [ ] После успешного спайка: VAD/конец фразы → STT → текущий LLM → TTS → ответ в войс; музыка остаётся на втором боте.

## 12. Приоритет: аудит системных промптов и связей моделей

**Приоритетный аудит реализован локально в PR #27.** Гипотеза о стилистическом влиянии конкретной runtime-модели остаётся для live-приёмки. Карта вызовов и границы приведены ниже.

- [x] Инвентаризировать system prompts и реальные сообщения brain/talk/vision/memory/reflection/coder/classifier, включая retries/rewrite.
- [x] Persona напрямую в talk; brain получает нейтральную политику и факты/инструменты. Legacy persona_in_brain и get_character_profile больше не передают persona в brain. После talk вызовов brain для переписывания нет.
- [x] Английские нейтральные служебные инструкции; изменяемые persona и язык данных/ответа остаются отдельными. Подробность и структура сохраняются при talk rewrite/empty retry, полные lyrics не сокращаются из-за brief.
- [x] Discord, память и результаты инструментов отделены от system-role; ограничены по размеру и удаляются при reduced-context retry. Offline-регрессии проверяют фактически отправленные сообщения.
- [x] Повторная сверка brain/talk/memory/vision (2026-10-18): brain видит scoped публичную историю и тот же mood/relation, что talk; persona напрямую в talk на каждом запросе, включая rewrite и overflow. Brain-native vision не делает дополнительный caption-вызов тем же клиентом. 330 server tests, compileall, security/brain-failure scripts и validator 72/2/2 прошли; реальные модели не вызывались. Контракт pipeline приведён в этом разделе.
- [x] Согласованы и реализованы опциональные Responses только для talk и startup-прогрев persona. Два persisted-переключателя в Settings → «Речь» по умолчанию выключены; есть готовность, ошибки и ручной платный прогрев. Chat Completions сохраняет отправку persona каждый раз.
- [x] Persona/нейтральная политика — начальный system input item. Прогрев создаёт общую неизменную заготовку без пользовательских данных; беседы ответвляются независимо. Автор, время, mood/relations и факты brain передаются каждый ход; приватный контекст — ненаследуемые instructions. Brain не переписывает persona или ответ talk.
- [x] Менеджер цепочек и scoped STM: Discord-сервер/групповая личка — общая история канала с ID авторов; личка — ветка владельца. Для будущего приложения заложен private owner/session scope; Telegram-адаптер ещё не реализован. Личная память/отношения остаются по ID человека. 200 цепочек, 12 ходов/48k символов/30 минут простоя; сериализация всей беседы между event loops. Fingerprint и reset/wipe/рестарт исключают продолжение устаревшей политики.
- [x] Восстановление неизвестного parent ID/переполнения через persona и ограниченный публичный replay, без повторного brain/tools. Rewrite/empty retry не закрепляют отброшенные ответы; ошибка/отмена не продвигает цепочку. После публичного токена нет слепого повторения streaming.
- [x] Новая runtime-реализация прошла синтетические платные пробы AIHope на GLM/Qwen/DeepSeek/Luna/Sol: прогрев, обычный ответ, streaming, общий канал разных авторов и ненаследование приватного маркера. 30 генераций; реальные persona, Discord и память не использовались. Контракт сессий и проверки приведены в этом разделе. Сокращение payload не считается доказательством снижения billing.
- [x] Offline/интерфейс: 437 server tests, compileall, validator 75/3/3, все 14 stage/offline scripts; Node 22 lint/typecheck, 42 unit, build, 16 desktop/mobile E2E с настоящим API/SQLite, сохранением/ошибкой/отменой/перезагрузкой и прогревом. Проверены reset во время генерации, bounded overflow без повторного brain, исходный провайдер для cleanup; обе темы и скриншоты.
- [x] Исправлены замечания АР к a6e45f2: warmup использует `affect_data=None`, без state policy/data в seed; состояние и его политика остаются только в текущем talk-вызове. Slash-ошибки Discord — фиксированный локализованный текст, детали только в логах. Закрыт прежний AR-13: повтор после скрытого reasoning/плана сбрасывает фильтры и допускается до первого публичного текста.
- [x] AR-12: устаревший отдельный отчёт шлюза удалён по новому указанию пользователя от 2026-10-18; актуальные границы сессий сохранены в этом PLAN. Все удаления документации включены в PR.
- [x] Повторная приёмка после fixes памяти/АР: 454 server tests, compileall server/MCP, validator 75/4/4 и все 14 stage/offline scripts; Node 22 lint/typecheck, 46 unit, build и 18 desktop/mobile E2E. У lint осталось только прежнее предупреждение LogViewer.
- [ ] Live-приёмка пользователем: настоящая persona/Discord, длительная работа, TTL/compaction/рестарты шлюза, межключевая изоляция и фактический billing. Синтетические пробы эти критерии не закрывают.
- [x] Первый разрешённый технический live-спайк AIHope (2026-10-18, до исправлений шлюза; исторический результат): Chat Completions/streaming и cache hits работают на talk/brain-моделях; `/responses` генерирует на Luna/Sol, но продолжение по ID дало 400 либо 200 без восстановления маркера, retrieve/delete/Conversations — 404. Ручной replay работает. Сохранение сессии не подтверждено, persona остаётся в каждом запросе. Только синтетические данные; качества persona, Discord, production-памяти и billing эта проверка не закрывает.
- [x] Промежуточный спайк v2 после исправления AIHope (исторический результат): `glm-5.3-flash`, `qwen3.8-flash`, `deepseek-v4.1-flash`, `gpt-6.1-sol`, `gpt-6-luna` восстанавливают контекст по previous_response_id (строка/массив input), сохраняют начальный system item; retrieve/delete, обычный chat/stream и ручной replay работают. Остались внешние дефекты: Responses stream возвращает JSON, top-level instructions не применяется, Conversation не подключает историю и items даёт 404. Кэш наблюдался на четырёх моделях; для DeepSeek три повтора без hit не доказывают отсутствие поддержки. Runtime не переводился на Responses; TTL, compaction, рестарты шлюза и межключевая изоляция не проверены.
- [x] Предыдущий спайк v3 всех пяти моделей на `https://aihope.fun/v1` (исторический результат): три внешних дефекта снова воспроизвелись; работа previous_response_id, system item, retrieve/delete и Chat streaming подтверждена повторно. DeepSeek теперь дал cache hits; на GLM в этом прогоне hit не наблюдался, ранее был. Для Discord отдельно реализована финальная отправка, без изменения LLM-протокола. Приёмка production-сессий и смена API остаются отдельной задачей.
- [x] Заключительный спайк v4 AIHope (2026-10-18): на всех пяти моделях подтверждены Chat/stream/usage, previous_response_id (строка/массив/stream), начальный system item и retrieve/delete. Три прежних дефекта исправлены: Responses отдаёт SSE, top-level instructions применяется в текущем запросе, Conversation восстанавливает историю и items отвечает 200. Top-level instructions не наследуется через previous_response_id — это штатный контракт; повторная передача проверена на Luna. На Luna два ответа 200/completed были пустыми с output_tokens=0 (70.62/34.28 s); контрольные повторы, включая Conversation/items, прошли, нестабильность остаётся открытой в BUG-09 (§3a). GLM с лимитом 128 потратил бюджет на reasoning; при 512 дал текст. Cache hits наблюдались на GLM/Qwen/DeepSeek/Luna; у Sol в трёх повторах поле cached_tokens отсутствовало, что не означает нулевой кэш. Все запросы синтетические; runtime остаётся на Chat Completions. Ранние выводы выше относятся к предыдущим состояниям шлюза; актуальный runtime-контракт описан ниже.
- [x] AR-9 PR #29: убрать assistant-prefill из rewrite и фильтровать его ответ от micro-plan (tags/anchor/незакрытый хвост). Восемь регрессий chat/stream подтверждают отсутствие утечки в публичный текст, STM/chat_log и diary; полный pytest 338, compileall, validator 72/2/2 и 14 stage/offline-скриптов прошли.
- [x] AR-10 PR #29: не пересылать сырые ошибки провайдера в Discord/WS. Обе ветки stream, включая неудачу после overflow, возвращают безопасный текст; адаптеры выбирают его по коду, сообщение о недоступном brain сохранено. Девять дополнительных регрессий; полный pytest 357, compileall, validator 72/3/3 и 14 offline-скриптов прошли.
- [x] AR-11 PR #29: описание переписано под итоговый scope — mood/relations, переключатели, pipeline, финальная отправка Discord, безопасные ошибки и последний спайк шлюза. Актуальные результаты: 357 server tests, validator 72/3/3; старые промежуточные выводы не выдаются за текущие.
- [x] Повторный аудит пользовательской схемы brain → talk → memory/vision: persona остаётся только в talk; brain получает ту же scoped историю и состояние, видит публичный ответ на следующем ходе. Исправлены REST-ошибки и их failed trace, empty retry (без prefill/private plan), ограниченные факты brain/vision после overflow, owner/channel-изоляция image notes и их reset/wipe; результаты последнего разрешённого инструмента не теряются при исчерпании бюджета. Явные reasoning-блоки brain не передаются talk, а потоковые reasoning-блоки talk фильтруются до WS-токенов, включая вложенные/незакрытые теги; после публичного токена генерация не повторяется слепо. 36 дополнительных регрессий; полный pytest 393, compileall, validator 72/3/3 и 14 stage/offline scripts прошли. На момент этого аудита Responses runtime и платный startup warmup ещё не были реализованы; последующая реализация описана выше.
- [ ] Live: проверить стиль, смысл и соблюдение границ настоящими моделями, включая runtime persona и все выбранные режимы.


### Настройки и эксплуатационные границы

- Источники конфигурации: tracked `*.example.yaml`, schema и общие руководства `docs/en/`/`docs/ru/`. Слои YAML сохраняются раздельно; секреты только в `.env`. `regen_config_keys_md.py` печатает справочник из examples в stdout.
- Settings → «Поведение»: `memory.mood.enabled`, `memory.relations.enabled`, `memory.diary_after_turn` и `agent.de_repeat.enabled` по умолчанию true. `memory.working_memory.enabled`, `memory.pre_context.enabled`, `memory.emotional_layer.enabled`, `memory.emotional_layer.ltm_emotion_sync` по умолчанию false. Применяются к следующим ходам/заданиям; ltm_emotion_sync требует emotional_layer. Флаги строго boolean, null/строки/числа отвергаются; пустые необязательные YAML-блоки используют defaults.
- После мягкого рестарта: `memory.rag_enabled`, `memory.reflection_enabled`, `memory.small_reflection_enabled`, `memory.diary_hourly_enabled` (defaults true); `memory.ltm_auto_prune.enabled`, `memory.ltm_auto_summarize.enabled`, `mcp_client.enabled` (defaults false). Фоновые расписания требуют reflection_enabled; MCP сохраняется в modules.yaml. Сохранение не выполняет рестарт автоматически; уже начатые задания могут завершиться.
- Отключение mood/relations не удаляет данные; decay учитывает прошедшее время. Устаревшие affect-записи инвалидируются. Reset остаётся отдельным подтверждаемым действием с backup. Поиск RAG и rag_write_mode независимы; смена write mode/уровня логов применяется сразу. Auth, роли и границы доступа к памяти обязательны.
- Settings → «Речь»: `llm.talk_model.responses.enabled` и `llm.talk_model.responses.warmup_on_start`, оба false; сохраняются в config/llm.yaml без пересборки клиентов. Responses только для talk. Startup/ручной прогрев платный, требует включённого Responses; без периодического платного цикла. `GET /v1/llm/sessions` (viewer+) возвращает агрегаты/безопасные ошибки, `POST /v1/llm/sessions/warmup` (admin) обновляет заготовку и сбрасывает цепочки, сохраняя локальную память.
- Seed содержит только persona/нейтральную политику, без state policy, памяти и отношений. Общий seed неизменен, беседы ответвляются независимо. Приватные данные, state policy/data и факты brain идут в ненаследуемых request-local instructions. В обычном Chat Completions persona передаётся каждый раз; автоматического перехода между API нет.
- Discord guild channel/групповая личка имеют общую историю авторов; DM и будущее приложение используют private owner/session scope. Общая история не даёт доступа к личной памяти другого автора. Telegram и клиент ещё не реализованы.
- До 200 цепочек; новая после 12 ходов, 48 000 учтённых символов или 30 минут простоя при следующем обращении. Смена persona/model/provider/режима/флагов, сокращение STM, reset/wipe и рестарт инвалидируют цепочку. Весь ход одной беседы сериализован между event loops. Unknown parent/overflow восстанавливают persona и ограниченный публичный replay без повторного brain/tools; rewrite/empty retry не закрепляют отброшенные ответы. После публичного текста replay запрещён.
- Provider chains не сохраняются на диск. Удаление response ID ограничено по времени/очереди и выполняется best effort исходным подключением; удаления provider backups это не гарантирует. Response ID не считается request ID. Меньший payload не доказывает меньший billing; TTL, compaction и межключевую изоляцию проверяет пользователь отдельно.

### Память: проверка работы и улучшения

- [x] Повторная проверка Discord/ядра: запись факта не создаёт карточку по выдуманному ID/нику; известный Discord ID выбирает account owner, неоднозначные имена не выбирают человека. Cache/reflection не воскрешают удалённый merge source; account refresh сериализован с merge. Аватар и UUID сохраняются при смене ника. Старые дубли автоматически не склеиваются.
- [x] Память → Люди → Объединения: отдельный подраздел предложений/истории с именами, временем, причинами, поиском, страницами и статусом отмены. Undo сохранён с подтверждением; история отдаёт только безопасные подписи, без snapshot фактов. Реальные apply/undo, ошибка API и клавиатура проверяются локальным браузером.


Следующая часть приоритетного прогона: проверить память вместе с аудитом промптов, затем выбирать улучшения по найденным проблемам.

- [x] Подключить owner/channel-scoped STM и diary к реальным ходам и pre-context; WM обновлять последовательно по владельцу. Семантические знания и consolidation сохраняют owner, ночная reflection не угадывает людей по никам.
- [x] Проверить SQLite reopen и повторную миграцию старой временной схемы, dedupe diary по turn_id, удаление/очистку. Delayed jobs после wipe инвалидируются и не восстанавливают удалённое.
- [x] Автоматический diary после успешной пары — отдельная background job, без ожидания ответа. Неуспешные/отменённые ходы не создают запись. Технические итоги reflection пишутся в журнал; пустые/ошибочные summaries не удаляют исходники.
- [x] Подключить фактическую телеметрию memory/reflection/coder/classifier: отдельный lifecycle jobs, parent_turn_id, streaming usage/request IDs при наличии, ограниченный контекст. Configured и reported model различаются; отсутствующие provider model/usage/request ID не выдумываются. REST/WS, метаданные хода и Event Bus получают отчёт; защищённый `/v1/llm/activity` хранит до 200 ходов без текста/персональных ID.
- [ ] Live: качество отбора/сжатия/retrieval, отсутствие выдуманных фактов и стилистического дрейфа; замеры задержек/токенов и сверка billing на реальных данных. Offline-контракты не доказывают качество генерации.
- [ ] Live: миграция копии production SQLite, конкурентные jobs/рестарты и исправления противоречий на данных стенда по §7/§7.5.

**Граница приёмки:** локальную реализацию продолжили после остановки Kilo. Runtime-модели не переключались; рабочий сервер, Discord и production-память не запускались. Отдельно разрешённые синтетические API-пробы шлюза отмечены выше; они не заменяют пользовательскую live-приёмку после отдельной команды на деплой.

## 13. Переработка памяти и её интерфейса (после аудита §12)

Целевая схема раздела «Память»:

- **Короткая:** текущий контекст чата, который получает модель. Показывать фактическую историю/состав контекста; это не вся долговременная база и не скрытые рассуждения модели.
- **Промежуточная:** личный дневник Нейры, автоматически формируемый после каждой завершённой пары «сообщение пользователя + ответ Нейры». Записи от первого лица Нейры, без внешнего рассказчика и выдуманных событий.
- **Долгая:** устойчивые сведения, отобранные после рефлексии и сохранённые в долгосрочную память. Показывать понятные записи, их происхождение и актуальность.

Локально реализовано в PR #27: STM — ограниченные окна процесса по owner/channel; diary — SQLite с владельцем/каналом; долгая память — факты профилей с источником. Старые записи не переписываются и не приписываются произвольному пользователю. Семантический retrieval сохранён, просмотр фактов не является полным экспортом Chroma.

- [x] **Журнал ядра:** System → «События памяти», только просмотр, обновление и admin delete/clear; без ручной формы.
- [x] **Дневник:** ручная форма убрана; запись от первого лица автоматически после завершённой пары. Новые источники запрашивают первое лицо; исторические записи сохранены. Соблюдение инструкции моделью — live-критерий.
- [x] AR-24: один канонический планировщик `memory.diary_after_turn`; прежние `llm.async_reflection.*` и diary-поля emotional_layer deprecated/ignored, мёртвые wrappers удалены. LTM tone metadata остаются отдельной действующей опцией.
- [x] AR-22/23/25/26: смешанные ошибки consolidation не оставляют частичных digest; debug показывает scoped окна; удаление записи журнала требует `УДАЛИТЬ`; wipe инвалидирует записи только затронутой секции, включая вложенные jobs. Проверено offline и browser-регрессиями; новое AR проверяется после push.
- [x] **Очистка и вайпы:** существующие API, роли, подтверждения и кнопки сохранены; регрессии прав/удаления и browser-сценарий удаления журнала.
- [x] **Поиск RAG:** техническая форма убрана; долгая память показывает факты/источник, исправления остаются в «Людях». Retrieval Нейры не отключён.
- [x] **Локальная приёмка:** три секции, отдельный журнал, empty/error/retry, клавиатура, обе темы и desktop/mobile; браузер получает действительные данные временного backend, не только mocks HTTP.
- [ ] **Live-приёмка пользователем:** реальные Discord-диалоги, качество дневника/долгой памяти, перезапуск на production-копии и жизненный цикл dashboard на работающем сервере.

## 14. Единая папка текстов и промптов (первая поставка реализована)

Выбраны JSON-каталоги в `server/resources/`: первая поставка system-промптов и основа ru/en уже реализованы. Открыты перенос остальных текстов и полная локализация; границы и проверки приведены ниже.

- [x] **Служебные system-инструкции:** первоначально 70, сейчас 75 английских блоков в `server/resources/prompts/en.json`: brain/talk, vision, rewrite/empty retry, memory/reflection, coder/delegate и Discord classifier/proactive. Правила сборки и лимиты остаются в коде; исходный текст builders/modes сверяется с golden из смерженного #27.
- [x] **Основа локализации:** `server/resources/messages/{ru,en}.json`, сейчас по 4 подключённых сообщения brain/empty reply/generation failed/slash failed; русский по умолчанию, английский fallback для отсутствующего перевода/неподдерживаемой локали. Это ещё не локализация приложения целиком.
- [ ] **Остальные тексты:** перенос пользовательских сообщений API/Discord/dashboard, tool descriptions и оставшихся data wrappers; выбор языка интерфейса и расширение переводов. Не менять язык system policy или пользовательского диалога вместе с UI locale.
- [x] **Persona:** существующие `server/prompts/persona.md` и appearance остаются отдельными редактируемыми файлами; напрямую в talk, не в каталог переводов/brain. Обёртка appearance вынесена отдельно от содержимого persona.
- [x] **Повтор пустого ответа (АР #28):** режим песни передаётся явно из состояния хода в chat/streaming, без поиска заголовков в редактируемых промптах или пользовательском тексте. Регрессии проверяют изменённый заголовок, brief, detailed/technical и обычный ответ.
- [x] **Границы первой поставки:** только статические шаблоны; пользовательские данные, память, ключи, API-коды, роли, лимиты и логика не выносятся. Роли сообщений и scope сохранены регрессиями pipeline.
- [x] **Загрузка и проверки первой поставки:** фиксированные пути от server package, кеш до рестарта, строгие именованные параметры без attribute/index/format expressions, ошибки неизвестных ключей/дубликатов/битых каталогов, проверка соответствия переводов. Отдельный validator в CI, загрузка не зависит от cwd.

## 15. Порядок завершения серверной части перед клиентом

Уточнение пользователя 2026-10-16: ближайшая очередь — **3a + баги, §7/§7.5, §12–15**. **§10 и §3b** — в конце. **§9 и §11** (включая второго бота) — после ВКР либо при наличии времени. Номера разделов сохранены для ссылок; положение в файле не задаёт приоритет.

Сначала готовый сервер, затем клиент для **Windows и Linux**. Контрольная точка «серверная половина» относится к работающему серверному контуру, а не к арифметике checkbox и не к готовности всей ВКР. Тема, объект, предмет и цель из §0 остаются без изменений. Минимум защиты всё ещё включает клиент.

- [x] PR #27 смержен в main как `2f235d7`: АР LGTM, CI 7/7 зелёный. Deploy не выполнялся.
- [x] PR #28 смержен в main как `d78dee7`: system resources и ru/en foundation; все три замечания АР закрыты, LGTM и CI 7/7. Перед merge повторно прошли 48 профильных тестов. Deploy не выполнялся.
- [x] Начать отдельно согласованный серверный этап §12/14: system resources + ru/en foundation, без смены поведения моделей и без клиента. Полная локализация остаётся открытой в §14.
- [x] Реализовать серверный MVP §7.5: сохраняемые Mood/Relations, ограниченные изменения/decay, scope по person_id, данные для brain/talk при persona только в talk, управление/reset и offline-регрессии. Сервер после повторного аудита brain/talk/memory/vision: 393 tests, compileall, validator 72/3/3 и все 14 stage/offline scripts. Ранее прошли 38 dashboard unit, 14 E2E и Node 22 lint/typecheck/build; dashboard в дополнительной сверке не менялся. Live-приёмка остаётся открытой в §7.5.
- [x] AR-8 PR #29: сохранить совместимость пустых необязательных YAML-блоков с defaults; некорректные scalar/list-родители и null/строковые boolean-флаги отклонять. Проверены реальная загрузка YAML, значения defaults и строгая валидация; полный pytest (320), compileall и stage 1c прошли.
- [x] Итоговый аудит реализации PR #29 перед merge: Mood/Relations, 17 переключателей, Responses/warmup, границы brain/talk/memory/vision, финальная отправка Discord, people dedupe и отдельный merge/undo UI завершены локально. На кодовом срезе `06948c7` все AR-1…18 закрыты (LGTM), CI 7/7; 454 server tests, 46 dashboard unit, 18 E2E. Последующая сверка меняет только PLAN/VERSION; деплой и релиз не выполнялись.
- [ ] Подтвердить серверный сценарий: подключение/авторизация → чат/streaming → память → управление модулем → диагностика → backup/restore. Offline-проверки уже реализованы; live-приёмку на стенде выполняет пользователь.
- [ ] Подтвердить проверки багов из §3a на Discord/browsermcp/провайдере; не выдавать внешнюю недоступность за исправленный код и не закрывать live-пункты автоматически.
- [ ] После ближайших серверных этапов вернуться к §10 и самостоятельному клиенту §3b для обеих ОС. Не начинать их параллельно текущей очереди.
- [ ] После ВКР либо при наличии времени — §9/§11; двухботовый голос не блокирует серверный рубеж.

Серверное ядро, API/auth, dashboard, память и backup/restore реализованы и проверены локально. Качество моделей, production-copy migration и интеграции требуют пользовательской live-приёмки. Windows/Linux клиент остаётся scaffold; полный путь server → client и поставка клиента пока не реализованы. Эта граница не позволяет объявить всю ВКР готовой по числу закрытых задач. История изменений — [VERSION.md](VERSION.md).
