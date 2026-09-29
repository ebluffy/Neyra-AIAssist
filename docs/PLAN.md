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

Установщик сервера остаётся в backlog. Для демонстрации сервера достаточно Docker Compose или systemd на mini-PC и `run_neyra.bat` на Windows. Установщик клиента NSIS и автообновление входят в Этап 3, но не являются минимумом защиты: для защиты достаточно собранного `setup.exe`.

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

До любых операций нужен полный внешний backup проекта и runtime-данных. Скрипт `server/scripts/migrate_runtime_layout.py`: сначала `--dry-run` (таблица), затем прогон с hash/size и `--report-memory` (Hub/Chroma). Переносит root `config.yaml`, `.env`, module configs, `memory/` → `server/data/memory/`, `logs/` → `server/logs/`, опционально legacy `Lavalink.jar` (или `fetch_lavalink.py`). Без `--force` target не перезаписывается; source удаляется только с `--remove-source` / `--cleanup-legacy-root`. Отчёт прогонов: `docs/stage-1b-evidence.md`.

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
- [x] Запущены compileall, healthcheck и smoke; логи — `docs/stage-1b-evidence.md`; CI — `.github/workflows/stage-1b-verify.yml`.
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

В начале 1c групповые записи inventory заменяются подробной таблицей: один ключ на строку, точный тип, default, источник чтения, target file, env override и compatibility status. До изменения общего loader проверяется фактический consumer и merge-поведение `interfaces/local_voice/config.yaml`.

### Готово, когда

- [ ] `server/config.yaml` не содержит дублирующей глубокой конфигурации и сохраняет совместимые defaults.
- [ ] Каждый конфигурационный ключ имеет тип, default, источник, target file и правило override.
- [ ] Loader валидирует схему до запуска и сохраняет понятные ошибки.
- [ ] `paths.data_dir` и `NEYRA_DATA_DIR` проверены на `server/data` после переноса memory/logs.
- [ ] Consumer и merge-поведение `interfaces/local_voice/config.yaml` проверены до изменения loader; поведение voice не исчезает молча.
- [ ] Legacy env aliases либо поддержаны с warning, либо явно документированы как миграция.

## 2. Control API поверх Internal API

Этап 2 строит Control API поверх текущего Internal API, не дублируя агентскую оркестрацию.

### Объём

- чат со streaming-ответом через WebSocket или SSE;
- health, модули, модели и версия API;
- список модулей, включение/выключение, start/stop;
- мягкий рестарт;
- токенная авторизация с ролями `viewer`, `maint`, `admin` через существующие `INTERNAL_API_*_TOKEN`;
- bind по умолчанию только на localhost;
- LAN только через явную настройку `INTERNAL_API_BIND_HOST` в `server/config/server.yaml` или env override;
- аудит изменяющих действий.

Вторая очередь Control API: GET/PUT конфигурации с серверной schema validation, hot reload и rollback при ошибке; список/чтение/сохранение промптов; логи.

### Готово, когда

- [ ] Опубликован versioned API contract для chat, health, modules, models и restart.
- [ ] Streaming работает через WebSocket или SSE и имеет reconnect/error semantics.
- [ ] Viewer не может менять состояние; maint/admin могут только разрешённые операции.
- [ ] localhost является default bind, LAN доступен только через явную настройку.
- [ ] Изменяющие действия пишутся в аудит без записи секретов.
- [ ] Пройдены API tests, auth tests и smoke через `server/scripts/healthcheck.py`.

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
- Dev MCP compile и import smoke: из `tools/mcp_server/` выполнить `python -m compileall -q server.py` и `python -c "import server; assert server.mcp.name == 'neyra-mcp-debug'"`; после 1b выполнить те же команды из `devtools/mcp_server/`. Import smoke проверяет регистрацию MCP app и не обращается к Internal API или секретам.
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

Реорганизация `server/` / `client/` / `devtools/` выполнена. Приёмка владельца и политика переноса memory/logs: `docs/stage-1b-acceptance.md`. Прогоны: `docs/stage-1b-evidence.md`. Команды: `python server/scripts/verify_stage_1b.py` (на машине с данными — `--strict-memory`), `cd server && python scripts/healthcheck.py --mode core --skip-http`, `docker compose config` из корня. Дальше — **Этап 1c** (слои конфигурации).
