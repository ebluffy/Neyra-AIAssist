# PLAN.md — Neyra-AIAssist

> Глобальный план развития от текущего стенда к локальному серверу и клиентскому приложению управления. Формулировка темы, объект, предмет и цель ВКР фиксируются без изменений.

## 0. Контекст ВКР и критерий защиты

| Что | Значение |
|---|---|
| **Тема ВКР** | «Разработка прототипа модульной информационной системы персонального ИИ-ассистента с локальным сервером и клиентским приложением управления» |
| **Объект** | модульная информационная система персонального ИИ-ассистента |
| **Предмет** | архитектура, программные компоненты и способы взаимодействия локального сервера ИИ-ассистента с клиентским приложением управления |
| **Цель** | разработать прототип модульной информационной системы персонального ИИ-ассистента с локальным сервером и клиентским приложением управления |
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

| Сейчас | После 1b | Действие |
|---|---|---|
| `core/` | `server/core/` | перенести серверное ядро |
| `interfaces/` | `server/modules/` | перенести серверные модули и обновить imports |
| `frontend/` | `server/dashboard/` | перенести существующий серверный dashboard |
| `scripts/` | `server/scripts/` | перенести серверные проверки и утилиты |
| `prompts/` | `server/prompts/` | перенести серверные prompt/persona-файлы |
| `sounds/` | `server/sounds/` | перенести серверные звуки; UI-звуки клиента входят в client bundle |
| `models/` | `server/models/` или внешний runtime cache | классифицировать; кэш не включать в package без необходимости |
| `tools/mcp_server/` | `devtools/mcp_server/` | переместить dev-only MCP, не включать в server/client package |
| `memory/` | `server/data/memory/` | SQLite Hub, Chroma и пользовательская память; перенос только migration helper с проверкой hashes |
| `logs/` | `server/logs/` | runtime logs; перенос migration helper с проверкой |
| отсутствующий продуктовый `client/` | `client/` | создать отдельный Tauri-проект, не переиспользовать `frontend/` |
| корневой `PLAN.md` | удалить | канон уже в `docs/PLAN.md`; дубликат не оставлять |

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

Этап 2 делает HTTP/WS control plane частью ядра: пакет [`server/core/api/`](../server/core/api/), конфиг `api:` в [`server/config/server.yaml`](../server/config/server.example.yaml). Отдельного второго API и модуля `modules/internal_api/` нет.

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

## 3. Windows-клиент

Клиент — **Tauri 2 + React + TypeScript**, тонкое окно управления сервером.

### MVP-экраны

- Подключение: адрес сервера и токен; токен хранится через Windows Credential Manager, не открытым текстом.
- Чат: server-side history и streaming.
- Статус: health, modules, models и API version. Экран называется «Статус», не «Дашборд».
- Модули: список, состояние, включение/выключение и start/stop.

Клиент открывается без сервера и показывает состояние «сервер недоступен». В сборку клиента входят UI, стили, иконки, шрифты и звуки самого приложения. Сервер отдаёт через API чат и историю, память, конфиги, промпты, модули и их состояние, логи и статус. TTS генерирует сервер, клиент только проигрывает аудио.

Локально у клиента хранятся только адрес сервера, токен в Windows Credential Manager, тема, размер окна и кэш последнего статуса. `server/dashboard/` остаётся запасным web-интерфейсом; клиент его не переиспользует и ходит в тот же Control API.

Вторая очередь: Monaco-редактор промптов и конфигов, логи и настройки приложения.

### Доступ из интернета и публикация под доменом

Канонический сценарий для диплома и удалённого клиента: Neyra Server крутится на **домашнем сервере** (мини-ПК, старый ПК, ноутбук и т.п.), наружу — через **frp** (frpc на домашнем сервере, frps на VPS) под поддоменом `neyra.owyx.site`. DNS, frps/Caddy и frpc настраиваются **в рамках Этапа 3** вместе с Windows-клиентом: сразу хостится Control API для приложения, а не откладывается «на потом».

#### Схема

```text
Клиент (Tauri)
  → https://neyra.owyx.site
  → wss://neyra.owyx.site/api/v1/ws/chat
  → Caddy или nginx на VPS (TLS Let's Encrypt)
  → frps (vhost HTTP, порт например 8080)
  → frpc на домашнем сервере
  → Control API 127.0.0.1:8787
```

Публичный путь чата — `wss://neyra.owyx.site/api/v1/ws/chat` (`api.public_path_prefix: /api`). За прокси префикс `/api` снимается; приложение слушает локально `/v1/ws/chat`. WebSocket должен проходить всю цепочку без обрыва (Upgrade; см. `docs/ru/ops/api-reverse-proxy.md` / `docs/ru/ops/wss-deployment.md`).

#### Пример frpc.toml (домашний сервер)

```toml
# Общий auth.token должен совпадать с frps (не коммитить).
serverAddr = "VPS_IP_OR_HOST"
serverPort = 7000
auth.method = "token"
auth.token = "REPLACE_ME"

[[proxies]]
name = "neyra-api"
type = "http"
localIP = "127.0.0.1"
localPort = 8787
customDomains = ["neyra.owyx.site"]
```

На стороне frps — тот же `auth.token` и HTTP vhost (порт, на который смотрит Caddy/nginx). Секреты frp только в локальных конфигах / env, не в git.

#### Требования к серверу при внешней публикации

- Токены и роли (`API_TOKEN` / viewer / maint) **обязательны** при внешнем доступе: без токена — отказ старта или только loopback (`127.0.0.1`).
- Bind по умолчанию `127.0.0.1`; порт **8787 наружу напрямую не открывать** (только через frpc → VPS → TLS).
- `api.public_base_url` / `api.public_path_prefix` согласованы с доменом (пример: `https://neyra.owyx.site` + `/api`).
- `NEYRA_DEBUG_LIFECYCLE` **не** включать в публикуемой конфигурации.
- Rate-limit учитывает `X-Forwarded-For` за прокси (реальный клиент, не IP VPS).
- Токен в query (`?token=`) — только если нет альтернативы (заголовок / Credential Manager в клиенте предпочтительнее; query утекает в логи прокси).

#### Данные

- Память (`server/data/memory/`), `.env`, логи и модели остаются на **домашнем сервере**.
- На VPS — только reverse proxy + frps: **без** копирования памяти, секретов и runtime-данных Neyra.

#### Альтернатива

Тот же Docker Compose на VPS — **запасной стенд** (демонстрация / CI / fallback), не замена канону «домашний сервер + frp» для персонального ассистента с локальными данными.

#### Чеклист Этапа 3 (хостинг API + клиент)

- [ ] A-запись `neyra.owyx.site` → IP VPS.
- [ ] frps + Caddy (или nginx) на VPS: TLS Let's Encrypt, прокси на frps vhost, WebSocket Upgrade.
- [ ] frpc на домашнем сервере как служба (NSSM / Task Scheduler / systemd) с `type=http`, `localPort=8787`, `customDomains=["neyra.owyx.site"]`, общий `auth.token` с frps.
- [ ] Проверка WebSocket через прокси: `wss://neyra.owyx.site/api/v1/ws/chat` доходит до Control API.
- [ ] Адрес сервера в клиенте по умолчанию из **настроек** (сохранённый URL), не зашитый в сборку; для демо можно подсказать `https://neyra.owyx.site`.

### Сборка и автообновление

- Tauri 2 bundler, NSIS `setup.exe`, `installMode: currentUser`; MSI не нужен.
- Автообновление через `@tauri-apps/plugin-updater`; подпись через `tauri signer generate`.
- Приватный ключ и пароль только в GitHub Secrets: `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
- Публичный ключ в `tauri.conf.json`; endpoint — `latest.json` в GitHub Releases.
- Проверка обновлений при старте и кнопка «Проверить обновления», диалог версии и restart после установки.
- `.github/workflows/client-release.yml` на `windows-latest` через `tauri-apps/tauri-action`, trigger `client-v*`; PR CI делает lint, typecheck и build без релиза.
- Единая версия в `package.json`, `tauri.conf.json` и `Cargo.toml`.
- При подключении клиент проверяет совместимость версии API.
- Сертификат подписи кода для SmartScreen — backlog.

### Готово, когда

- [ ] MVP-экраны подключены к Control API и не содержат server-side orchestration.
- [ ] Клиент корректно работает при недоступном сервере.
- [ ] Токен не хранится открытым текстом.
- [ ] Собирается NSIS `setup.exe` для current user.
- [ ] Автообновление и error state проверены на тестовом release.
- [ ] PR CI выполняет lint, typecheck и build; release CI создаёт `latest.json`.
- [ ] Публикация `neyra.owyx.site`: DNS + frps/Caddy на VPS + frpc-служба на домашнем сервере; WSS-чат через прокси работает.
- [ ] Клиент берёт URL сервера из настроек (не hardcoded); внешний доступ только с токенами, bind localhost, данные только на домашнем сервере.

## 4. Серверная поставка и модульная эксплуатация

- Docker Compose и systemd остаются поддерживаемыми серверными способами запуска.
- `run_neyra.bat` остаётся Windows entrypoint для локального запуска.
- Docker contexts, volumes, healthchecks и systemd paths используют `server/`.
- Новые интеграции добавляются как server modules через Event Bus и Control API.
- Публичные и локальные LLM/voice providers остаются заменяемыми конфигурацией.

### Готово, когда

- [ ] Сервер запускается через Docker Compose, systemd-документацию и Windows batch entrypoint.
- [ ] Runtime data, secrets и модели не попадают в исходный пакет случайно.
- [ ] Минимум один модуль проходит enable/disable и health smoke.
- [ ] Документированы установка и восстановление после backup.

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

## 7. Постзащитное развитие

- Установщик сервера для Windows/Linux.
- Сертификат подписи клиента для SmartScreen.
- Редактор промптов и конфигов, логи и расширенные настройки клиента.
- Полный local voice loop и дополнительные player integrations.
- Расширенный MCP marketplace/allowlist и production deployment hardening.

### Готово, когда

- [ ] Каждая post-defense функция имеет отдельный issue/design и не блокирует MVP.
- [ ] Backward compatibility и миграция данных определены до релиза.

## Этап 1b — закрыт (PR #14)

Реорганизация `server/` / `client/` / `devtools/` выполнена. Приёмка политики memory/logs и post-migrate baseline — в PR #14. CI `Stage 1b verify` зелёный.

## Этап 1c — закрыт (PR #15)

Слои `server/config/*.yaml`, короткий root, `config_loader` + schema, inventory в `docs/config-keys.md`, `verify_stage_1c.py` + CI.

## Этап 1d — закрыт (PR #16)

Dual-backend: `llm.<role>.provider` (talk→OpenRouter, brain/memory/vision→AIHope), баланс dual, keys only from `.env`, `verify_stage_1d.py` + CI. Без legacy `BACKEND` / `openrouter:` / dual-read.
