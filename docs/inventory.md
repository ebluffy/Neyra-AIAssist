# Инвентаризация репозитория Neyra

> Этап 1a. Ниже перечислены фактические исходные пути и целевые пути после 1b. Runtime-файлы под `.gitignore` перед миграцией сверяются локально; их отсутствие в Git не означает, что их можно удалить.

## 1. Верхний уровень: откуда → куда

| Сейчас | После 1b | Назначение и решение |
|---|---|---|
| `core/` | `server/core/` | ядро, агент, память, LLM, runtime, tools и Event Bus; серверный код |
| `interfaces/` | `server/modules/` | Discord, Internal API, local voice и example module; продуктовые модули |
| `frontend/` | `server/dashboard/` | текущий web dashboard остаётся серверным fallback UI, не Windows-клиентом |
| `tools/mcp_server/` | `devtools/mcp_server/` | MCP для разработки и AI-агентов; не включать в runtime server/client packages |
| `scripts/` | `server/scripts/` | server healthcheck, plugin invocation, Lavalink plugin fetch, voice preflight и migration/test scripts |
| `prompts/` | `server/prompts/` | системные prompts и persona assets |
| `sounds/` | `server/sounds/` | звуки ответа сервера; UI-звуки клиента принадлежат `client/` bundle |
| `models/` | `server/models/` или внешний runtime cache | проверить вес/назначение; не включать скачиваемый cache в package без необходимости |
| `memory/` | `server/data/memory/` | SQLite Hub, Chroma и пользовательская память; перенос migration helper с hash/size check после backup |
| `logs/` | `server/logs/` | runtime logs; перенос migration helper с проверкой |
| root `config.yaml` (ignored runtime file) | `server/config.yaml` | перенести с сохранением пользовательских значений |
| root `.env` (ignored runtime file) | `server/.env` | перенести секреты без печати и коммита |
| `interfaces/discord/config.yaml` (ignored runtime file, проверить наличие) | `server/modules/discord/config.yaml` | мигрировать отдельно; tracked example указан ниже |
| `interfaces/internal_api/config.yaml` (ignored runtime file, проверить наличие) | `server/modules/internal_api/config.yaml` | мигрировать отдельно; tracked example указан ниже |
| `interfaces/local_voice/config.yaml` (ignored runtime file, проверить наличие) | `server/modules/local_voice/config.yaml` | до смены loader выяснить consumer и merge behavior |
| `interfaces/discord/lavalink/Lavalink.jar` (локальный/ignored runtime artifact, проверить наличие) | `server/modules/discord/lavalink/Lavalink.jar` либо документированный server runtime path | сверить наличие и launcher; не терять и не коммитить автоматически |
| `main.py`, root entrypoints и Docker Compose | server entrypoints под `server/`; thin launch/deploy files могут остаться в root | выполнять из `server/` либо выставлять `PYTHONPATH=server` |
| корневой `PLAN.md` | удалить | канон — `docs/PLAN.md`; дубликат в корне не нужен |
| `docs/inventory.md` | `docs/inventory.md` | карта аудита остаётся в docs; исключена из legacy-path scan по условию 1b |
| отсутствующий продуктовый `client/` | `client/` | новый Tauri 2 + React + TypeScript Windows control client |

## 2. Фактические module paths и конфиги

Tracked example paths сверены с деревом репозитория. Runtime `config.yaml` ниже ignored и может существовать только в локальной рабочей копии.

| Откуда (runtime) | Откуда (tracked example/module) | Куда после 1b | Примечание |
|---|---|---|---|
| `interfaces/discord/config.yaml` (ignored; наличие проверить локально) | `interfaces/discord/config.example.yaml` | `server/modules/discord/config.yaml` и соседний `config.example.yaml` | Discord/music/Lavalink module; перенести реальный конфиг отдельным migration step |
| `interfaces/internal_api/config.yaml` (ignored; наличие проверить локально) | `interfaces/internal_api/config.example.yaml` | `server/modules/internal_api/config.yaml` и соседний `config.example.yaml` | Internal API module; сохранить текущие tokens, bind и port |
| `interfaces/local_voice/config.yaml` (ignored; наличие проверить локально) | `interfaces/local_voice/config.example.yaml` | `server/modules/local_voice/config.yaml` и соседний `config.example.yaml` | Сначала найти точного consumer; не менять общий loader до проверки merge path |
| runtime-конфига у example module нет в tracked tree | `interfaces/000EXAMPLE/` (`plugin.yaml`, `core/main.py`, README/help files) | `server/modules/000EXAMPLE/` | реальный example module и template; сохранить как developer template |
| `tools/mcp_server/server.py`, `tools/mcp_server/requirements.txt` | source tree `tools/mcp_server/` | `devtools/mcp_server/` | dev tooling, не продуктовый модуль |

## 3. Игнорируемые данные и безопасная миграция

`git mv` переносит только tracked files. До 1b нужен полный внешний backup проекта и локальных runtime-данных. После backup отдельный migration helper переносит найденные ignored files из источника в соответствующее назначение, выводит список source/destination, сверяет размеры или hashes, не перезаписывает target без явного флага и сохраняет source до успешного запуска.

Обязательный набор проверки и переноса: root `config.yaml` → `server/config.yaml`, root `.env` → `server/.env`, все module `config.yaml`, `memory/` → `server/data/memory/`, `logs/` → `server/logs/`, SQLite Hub, Chroma persistence и Lavalink JAR. Отсутствующий путь отмечается как отсутствующий и не создаётся поверх другой копии автоматически. После переноса проверить чтение Hub/Chroma по новому path, server startup, Internal API, Discord/Lavalink и local voice config consumer. Default `paths.data_dir` после 1b — `server/data` (override `NEYRA_DATA_DIR`).

## 4. Конфигурация: ключи и env

В этой инвентаризации группировка ниже задаёт области аудита. В начале 1c каждый конкретный ключ должен быть отдельной строкой с точным type, default, source, target file, env override и compatibility status. Defaults не выдумывать: снять из текущих loaders и config examples.

| Область | Фактический источник сейчас | Целевой файл после 1c |
|---|---|---|
| `assistant.name`, `assistant.language`, `assistant.profile` | root config consumers в `core/agent/persona.py` и bootstrap | `server/config.yaml` |
| provider/model roles: `MODE`, `BACKEND`, OpenRouter/AiHope profile, talk/brain/memory/vision models | `core/llm/profile.py`, `core/agent/llm_setup.py`, bootstrap | `server/config/llm.yaml` |
| generation, retry/fallback, timeout and context settings | `core/agent/llm_setup.py`, `core/llm/` | `server/config/llm.yaml` |
| agent, prompt runtime, reflection/planning, vision and fast path | `core/agent/`, `core/llm/` | `server/config/agent.yaml` |
| `memory.*`, external storage and backup policies | `core/memory/`, runtime storage/backup consumers | `server/config/memory.yaml` |
| voice/STT/TTS, including legacy voice aliases | `core/voice/config.py`, `core/voice/stt.py` | `server/config/voice.yaml` |
| module enablement and MCP allowlist | `core/plugins/config.py`, `core/runtime/mcp_client.py` | `server/config/modules.yaml` |
| logging, health monitor, timezone/runtime settings | bootstrap, `core/runtime/health.py`, memory hub | `server/config/runtime.yaml` |
| Internal API, bind host and dashboard server settings | `interfaces/internal_api/`, server runtime and `frontend/` consumers | `server/config/server.yaml` |
| Discord-specific settings | `interfaces/discord/` | `server/modules/discord/config.yaml` |
| data path | memory/runtime path consumers | `server/config.yaml` key `paths.data_dir` |

### 4.1 Environment variables

| Variable | Назначение | Решение |
|---|---|---|
| `OPENROUTER_API_KEY` | OpenRouter provider secret | оставить в server `.env` |
| `AIHOPE_API_KEY` | AiHope-compatible provider secret | оставить один раз в inventory и server `.env` |
| `DEEPGRAM_API_KEY`, `GROQ_API_KEY`, `YANDEX_API_KEY`, `YANDEX_FOLDER_ID`, `YANDEX_ID_KEY` | voice/STT/TTS providers | сохранить используемые значения и aliases |
| `DISCORD_TOKEN` | Discord module | сохранить в server `.env` |
| `INTERNAL_API_TOKEN`, `INTERNAL_API_VIEWER_TOKEN`, `INTERNAL_API_MAINT_TOKEN` | Control/Internal API roles | сохранить, не логировать и не печатать |
| `HF_TOKEN`, `HUGGING_FACE_HUB_TOKEN` | доступ к gated Hugging Face models | optional, закомментировать в `.env.example`; public embeddings и Whisper не требуют токена |
| `NEYRA_DATA_DIR` | override для `paths.data_dir` | optional; default 1b остаётся на текущем physical location |
| `INTERNAL_API_BIND_HOST` | bind override | default localhost; LAN только явной настройкой |
| `SCREEN_PROXY_SECRET` | активный consumer не подтверждён | убрать из active example, оставить в backlog |

Dev MCP env перечисляется отдельно только после сверки фактических имён с `tools/mcp_server/server.py` и связанным dev config; секреты dev MCP не относятся к server/client product `.env`.

## 5. Реальные entrypoints и product tools

| Сейчас | После 1b | Назначение |
|---|---|---|
| `main.py` | `server/main.py` | запуск сервера; cwd `server/` или `PYTHONPATH=server` |
| `scripts/healthcheck.py` | `server/scripts/healthcheck.py` | health/API smoke |
| `scripts/invoke_plugin.py` | `server/scripts/invoke_plugin.py` | вызов и диагностика server module |
| `scripts/fetch_lavalink_plugins.py` | `server/scripts/fetch_lavalink_plugins.py` | получение Lavalink plugins |
| `scripts/voice_preflight.py` | `server/scripts/voice_preflight.py` | проверка voice runtime prerequisites |
| `run_neyra.bat`, `run_neyra.sh`, Windows launcher | тонкие root launchers, запускающие `server/` | сохранить пользовательский способ запуска |
| Docker Compose и Docker metadata | deployment files в root с paths на `server/` | серверная поставка, volumes и healthchecks |
| `tools/mcp_server/server.py` | `devtools/mcp_server/server.py` | dev-only MCP server; исключить из product runtime |
| `core/tools/` | `server/core/tools/` | продуктовые tools, вызываемые ядром; остаются на сервере |

## 6. Сохранить при переносе

| Компонент | Решение |
|---|---|
| `interfaces/local_voice/` | перенести; проверить реальное чтение `config.yaml` и не терять config behavior |
| `interfaces/internal_api/` | перенести весь модуль, включая существующие API contracts и незавершённые handlers; stubs документировать, не удалять автоматически |
| `interfaces/discord/` | перенести весь Discord/music/Lavalink integration и его примеры конфигов |
| provider contracts с `NotImplementedError` | сохранить contracts; отсутствующие реализации — backlog |
| `interfaces/000EXAMPLE/` | сохранить как реальный module SDK/template |
| `frontend/` | перенести в `server/dashboard/`; не смешивать с новым `client/` |
| SQLite Hub, Chroma, `memory/`, `logs/` | backup → `server/data/memory/` и `server/logs/` с hash/size check; default `paths.data_dir` = `server/data` |
| `tools/mcp_server/` | переместить в `devtools/mcp_server/`, не удалять и не ставить как runtime dependency |

## 7. Решения и вопросы перед 1b

### Зафиксировано

- Windows client: Tauri 2 + React + TypeScript; MVP screens Подключение, Чат, Статус, Модули.
- Client — thin UI; сервер владеет state, history, memory, prompts, configs, modules, logs, status и генерирует TTS.
- Client bundle включает собственные UI assets; без сервера показывает «сервер недоступен».
- Локальные client data: адрес сервера, токен в Windows Credential Manager, тема, размер окна и кэш последнего статуса.
- Control API использует текущие Internal API tokens/roles; default localhost, LAN только явной настройкой.
- Server installer — backlog; client NSIS installer/updater входят в Этап 3, но в минимум защиты входит только рабочий `setup.exe`.
- `paths.data_dir` + `NEYRA_DATA_DIR`; после 1b default data path — `server/data` (`memory/` → `server/data/memory/`, `logs/` → `server/logs/`).
- Корневой `PLAN.md` удаляется; канон только `docs/PLAN.md`.
- ADR `0002-core-layout-1b` — историческая упаковка пакетов внутри `core/`, не путать с Этапом 1b (server/client/devtools) этого PLAN.
- HF tokens optional и закомментированы в `.env.example`.

### Проверить до миграции

- Локальное наличие ignored root/module configs, `.env`, `memory/`, `logs/`, SQLite/Chroma data и Lavalink JAR; сделать backup до переноса.
- Точный consumer `interfaces/local_voice/config.yaml` и почему конфиг не попадает в общий merge.
- До 1c собрать отдельную строку на каждый config key с type/default/source/target/env override.
- Source paths для шаблона, Internal API, Discord и MCP сверены по фактическому tracked tree в разделе 2.

Начало Этапа 1b — только после отдельного сообщения пользователя «ок на 1b».
