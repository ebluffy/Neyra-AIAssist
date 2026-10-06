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

Результат аудита находится в `docs/inventory.md`. В нём зафиксированы реальные исходные пути, ignored-файлы, конфигурационные ключи, env-переменные, точки входа и маршруты переноса.

### Готово, когда

- [x] В inventory перечислены исходные каталоги и файлы с направлением «откуда → куда».
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

Замечание: ADR `docs/adr/0002-core-layout-1b.md` описывает **другой**, уже принятый этап упаковки пакетов внутри `core/` (`core.memory`, `core.plugins`, …). Этап **1b этого PLAN** — перестройка `server/` / `client/` / `devtools/`; это не одно и то же.

### Готово, когда

- [x] Выполнен полный backup до `git mv` и до миграции ignored-файлов.
- [x] Серверные файлы перенесены в `server/`, создан отдельный `client/`, dev MCP перенесён в `devtools/mcp_server/`.
- [x] Ignored-конфиги, `.env`, `memory/` → `server/data/memory/`, `logs/` → `server/logs/` перенесены; Lavalink JAR — `.gitignore` + `fetch_lavalink.py` (опционально FILE move в migrate).
- [x] SQLite Hub, Chroma и пользовательская память доступны без потери данных по новому default path `server/data/`.
- [x] Все entrypoints работают из `server/` или через `PYTHONPATH=server`.
- [x] Нет дубликатов runtime в корне (`.env`, `config.yaml`, `memory/`, `logs/`); канон только под `server/`.
- [x] Нет переходных алиасов и fallback-импортов на старую структуру (loader/builder/MCP только `server/modules/`).
- [x] Поиск по коду, скриптам, Docker и README (кроме `docs/inventory.md` и `docs/PLAN.md`) не находит `interfaces/`, `frontend/`, `tools/mcp_server` — проверка: `python server/scripts/verify_stage_1b.py`.
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
- [x] Каждый конфигурационный ключ имеет тип, default, источник, target file и правило override (`docs/config-keys.md`).
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

`server/dashboard/` — ops/admin control plane (статус, модули, память, система, вебхуки, настройки, docs), пока нет десктоп-клиента. Экраны в `screens/`, `components/ui/`, `api/`, `styles/` позже переносятся в `client/` (или shared-пакет); shell/gate — только веб. UI сейчас на русском; ru/en — позже.

**Люди (память):** в `meta.static_facts` только опциональные `first_name` / `last_name` / `birth_date` / `city`; остальное — `person_facts`. CRUD в дашборде; агент обновляет через tools.

Модули в вебе: действия по `lifecycle` (resident → soft-restart ядра; on_demand → invoke; общий enable/config). Scaffold/import-export модулей — полигон для 3b (shared UI → desktop Monaco): сначала шаблон + yaml, код-редактор — во второй очереди клиента.

**Discord / ответ модели (закрывать в 3a):**
- [x] Сохранять переносы строк в user-facing reply (не схлопывать `\s+` в одну строку).
- [x] Brain-native vision: talk тоже видит картинку, если talk = VL-модель; иначе caption для talk.
- [ ] Нормализованный Discord-контекст в payload до LLM: `current_user`, `channel`, `guild`, `message`, `addressed_to_bot`, `response_target` — не угадывать автора/адресата из текста подписи.
- [ ] Режимы общения (кратко / подробно / техн. / без шуток) — конфиг + хинт в talk prompt.
- [ ] Честность о модели: в ответе/логе/дашборде явный lane+model (talk/brain/vision), без «угадывания».

**Бэклог идей из живого чата (после 3a-блокеров, лёгкие — раньше):**
- Память без бардака: временный контекст / факты / устаревшее; confirm на sensitive; одна команда «забудь/поправь».
- Персонализация и профили людей (предпочтения тона, кто любит троллинг).
- Авто-выбор инструментов + краткий отчёт «что сделала».
- Устойчивость к неоднозначности: один уточняющий вопрос вместо веера догадок.
- Самопроверка ответа (противоречия / ссылки) перед send — опционально.

### Готово, когда (3a)

- [ ] Веб-панель закрывает ops-сценарии без десктопа (статус, модули, память, настройки, система).
- [ ] Discord: зрение + структурированные ответы стабильны на стенде.
- [ ] Нормализованный Discord-контекст в payload (не парсинг подписи).
- [ ] Модули: lifecycle-UX + (опционально) scaffold шаблона.

### 3b. Windows-клиент

Клиент — **Tauri 2 + React + TypeScript**, тонкое окно управления сервером. Shared screens из 3a переносятся в `client/`; shell/gate веб не тащим.

#### MVP-экраны

- Подключение: адрес сервера и токен; токен хранится через Windows Credential Manager, не открытым текстом.
- Чат: server-side history и streaming.
- Статус: health, modules, models и API version. Экран называется «Статус», не «Дашборд».
- Модули: список, состояние, включение/выключение и start/stop.

Клиент открывается без сервера и показывает состояние «сервер недоступен». В сборку клиента входят UI, стили, иконки, шрифты и звуки самого приложения. Сервер отдаёт через API чат и историю, память, конфиги, промпты, модули и их состояние, логи и статус. TTS генерирует сервер, клиент только проигрывает аудио.

Локально у клиента хранятся только адрес сервера, токен в Windows Credential Manager, тема, размер окна и кэш последнего статуса. URL сервера — из настроек клиента (в т.ч. публичный домен из §4); frp/прокси **не** часть Этапа 3b.

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
- [ ] Минимум один модуль: enable/disable + health smoke.
- [ ] Документированы установка и восстановление после backup.
- [ ] WSS-smoke по публичному URL зелёный.



## 5. Проверки, безопасность и качество

- Python compileall и unit/integration tests для затронутых серверных частей.
- API auth/role tests, config schema tests, migration dry-run и data preservation check.
- Dev MCP compile и import smoke: из `devtools/mcp_server/` выполнить `python -m compileall -q server.py` и `python -c "import server; assert server.mcp.name == 'neyra-mcp-debug'"`. Import smoke проверяет регистрацию MCP app и не обращается к Control API или секретам.
- Security boundary: localhost default, explicit LAN bind, token roles, audit и отсутствие секретов в логах.
- Тестовая матрица: Windows client/server unavailable, incompatible API version, stream reconnect, module failure и rollback config.



### Готово, когда

- [ ] Все обязательные проверки запускаются из новых каталогов и зелёные либо имеют внешний blocker.
- [ ] Secrets scan не находит токены в Git или логах.
- [ ] Smoke-путь «server → Control API → client» воспроизводим.
- [ ] Не потеряны memory, Chroma, SQLite Hub, ignored configs и Lavalink state.



## 6. Документация и демонстрация

- README и docs описывают границы server/client/devtools.
- Архитектурная схема показывает Control API, Event Bus, modules, memory и client.
- Demo script покрывает запуск сервера, подключение клиента, streaming chat, status, module toggle и soft restart.
- Отдельно описаны backlog: server installer, SmartScreen certificate, prompt/config editor и полноценный local voice loop.



### Готово, когда

- [ ] Документация запуска соответствует фактическим путям.
- [ ] Demo script укладывается в сценарий защиты.
- [ ] Backlog не смешан с обязательным MVP.



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
- [x] propose-only merge + atomic merge/undo + wipe confirm/backup + proposals UI; кнопки очистки в MemoryScreen.
- [x] Offline tests mention/resolve/merge/wipe + music soft-path зелёные; cutover = wipe.



## 8. Постзащитное развитие

- Установщик сервера для Windows/Linux.
- Сертификат подписи клиента для SmartScreen.
- Редактор промптов и конфигов, логи и расширенные настройки клиента.
- Полный local voice loop и дополнительные player integrations.
- Расширенный MCP marketplace/allowlist и production deployment hardening.
- **Обезличивание (AI Assist):** персона только из `assistant.*` + `prompts/persona.md`; ребренд репо/`neyra`-slug — отдельно после Stage 2, не блокер.



### Готово, когда

- [ ] Каждая post-defense функция имеет отдельный issue/design и не блокирует MVP.
- [ ] Backward compatibility и миграция данных определены до релиза.