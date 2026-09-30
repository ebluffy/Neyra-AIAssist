<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Соавторство: материал создан при поддержке ИИ-агента [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# MCP debug-сервер (`devtools/mcp_server`)

Официальный Python SDK MCP (`mcp`): подключение Cursor к Нейре для логов, вызовов Internal API, инъекции событий и инспекции памяти.

**Инструменты**

| Tool | Назначение |
|------|------------|
| `read_neyra_logs` | Хвост `logs/system.log` (или путь из конфига / `NEYRA_LOG_PATH`) |
| `neyra_api_request` | Произвольный HTTP к Internal API (`GET`/`POST`/…) |
| `neyra_health` | `GET /v1/health` — быстрый ping ядра |
| `neyra_lifecycle` | `POST /v1/debug/lifecycle` — **stop**/**restart** процесса (нужен admin-токен и включённый lifecycle; см. ниже) |
| `neyra_fire_event` | `POST /v1/debug/fire_event` — публикация в Event Bus |
| `neyra_read_config` | Чтение корневого `config.yaml` с маскированием секретов |
| `neyra_write_config` | `POST /v1/config/update` — только разрешённые поля ядра |
| `neyra_inspect_memory` | `GET /v1/debug/memory` — STM + статистика + RAG |

**Lifecycle (`neyra_lifecycle`):** по умолчанию выключен (API вернёт **403**), пока не задано `api.debug_lifecycle_enabled: true` или переменная `NEYRA_DEBUG_LIFECYCLE=1`/`true`/`yes` (**opt-in**: раскомментируйте в `docker-compose.yml` или задайте в `.env`). Для рестарта предпочитайте `POST /v1/system/restart`. Нужен **admin** Bearer (`API_TOKEN` или `API_KEY`). Действия **stop** и **restart** завершают процесс Python; повторный запуск в Docker — `restart: unless-stopped` или `docker compose restart`.

**Docker Desktop:** из корня репозитория: `docker compose up --build` (тонкий include → `server/docker-compose.yml`). На хосте MCP указывает `NEYRA_API_BASE=http://127.0.0.1:8787`. Логи — `server/logs/` на хосте; `read_neyra_logs` читает `server/config.yaml` / `NEYRA_LOG_PATH`. Секреты — `server/.env` (шаблон `server/.env.example`). Не публикуйте вывод `docker compose config`, если в нём есть секреты.

## Установка

Предпочтительно **основной venv проекта** (Windows: `.venv_win`, Linux/WSL: `.venv` или `~/neyra-venv`) — пакеты `mcp`/`httpx` уже есть при полной установке `server/requirements.txt`. В Cursor MCP указывайте этот интерпретатор и `devtools/mcp_server/server.py`.

Cursor поднимает MCP **параллельно с IDE** (stdio) при вызове tools; ядро Нейры должно быть запущено отдельно (`main.py --mode core`), иначе HTTP-tools к `http://127.0.0.1:8787` не достучатся.

Отдельный env нужен только для изоляции:

```bash
python -m venv .venv_mcp
.venv_mcp\Scripts\activate
pip install -r devtools/mcp_server/requirements.txt
```

Имя `.venv-mcp` устарело — не создавайте его.

## Путь к логу

1. Переменная `NEYRA_LOG_PATH`.
2. Иначе `logging.system_log` в `server/config.yaml` (обычно `./logs/system.log` при cwd=`server/`).
3. Иначе `server/logs/system.log`, затем `server/logs/neyra.log`.
4. Иначе ожидаемый default: `server/logs/system.log`.

## Подключение в Cursor

**Cursor Settings → MCP**, сервер **stdio**:

- **Command:** интерпретатор Python с установленными зависимостями.
- **Args:** полный путь к `devtools/mcp_server/server.py`.

Пример `env`: `NEYRA_LOG_PATH`, `NEYRA_API_BASE` (`http://127.0.0.1:8787`), `NEYRA_API_TOKEN` (если задан `api.token`), `NEYRA_CONFIG_PATH`.

Подробный пример JSON см. в английской версии: [mcp-debug-server.md](../../en/setup/mcp-debug-server.md) (блоки с `mcpServers`).

## Реализация

Файлы: `devtools/mcp_server/server.py`, `devtools/mcp_server/requirements.txt`.