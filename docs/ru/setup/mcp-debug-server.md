<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Соавторство: материал создан при поддержке ИИ-агента [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# MCP debug-сервер (`devtools/mcp_server`)

Официальный Python SDK MCP (`mcp`): подключение Cursor (или другого MCP-клиента) к Neyra для логов, вызовов Control API, инъекции событий и инспекции памяти. Runtime-поставка сервера **не** включает этот каталог — только devtools.

## Инструменты

| Tool | Назначение |
|------|------------|
| `read_neyra_logs` | Хвост `server/logs/system.log` (или путь из конфига / `NEYRA_LOG_PATH`) |
| `neyra_api_request` | Произвольный HTTP к Control API (`GET`/`POST`/…) |
| `neyra_health` | `GET /v1/health` — быстрый ping ядра |
| `neyra_lifecycle` | `POST /v1/debug/lifecycle` — **stop**/**restart** процесса (admin-токен + lifecycle; см. ниже) |
| `neyra_fire_event` | `POST /v1/debug/fire_event` — публикация в Event Bus |
| `neyra_read_config` | Чтение `server/config.yaml` (и слоёв) с маскированием секретов |
| `neyra_write_config` | `POST /v1/config/update` — только разрешённые поля ядра |
| `neyra_inspect_memory` | `GET /v1/debug/memory` — STM + статистика + RAG |

### Lifecycle (`neyra_lifecycle`)

По умолчанию выключен — API вернёт **403**, пока не задано:

- `api.debug_lifecycle_enabled: true` в merged config, или
- переменная `NEYRA_DEBUG_LIFECYCLE` = `1` / `true` / `yes` (**opt-in**: в `docker-compose.yml` или `server/.env`). Для рестарта предпочитайте `POST /v1/system/restart`.

Нужен **admin** Bearer (`API_TOKEN` / `api.token`). Действия **stop** и **restart** завершают процесс Python; повторный запуск — process manager, Docker (`restart: unless-stopped`) или вручную `python server/main.py`.

## Установка

Предпочтительно **основной venv проекта** (Windows: `.venv_win`, Linux/WSL: `.venv`) — `mcp` / `httpx` уже в `server/requirements.txt`. В Cursor MCP укажите этот интерпретатор и `devtools/mcp_server/server.py`.

Отдельный env (только для изоляции):

```bash
python -m venv .venv_mcp
# Windows: .venv_mcp\Scripts\activate
pip install -r devtools/mcp_server/requirements.txt
```

Имя `.venv-mcp` устарело — не создавайте его.

## Разрешение пути к логу

1. `NEYRA_LOG_PATH`, если задан.
2. Иначе `logging.system_log` в `server/config.yaml` (как у `main.py`, обычно `server/logs/system.log` при cwd=`server/`).
3. Иначе первый существующий файл: `server/logs/system.log`, затем `server/logs/neyra.log`.
4. Ожидаемый default: `server/logs/system.log`.

## Cursor MCP (stdio)

**Cursor Settings → MCP**, сервер **stdio**:

- **Command:** Python из основного venv (например `.venv_win\Scripts\python.exe`) или опционально `.venv_mcp`.
- **Args:** полный путь к `devtools/mcp_server/server.py`.

Cursor поднимает MCP **параллельно с IDE** (stdio); ядро Neyra должно быть запущено отдельно (`python server/main.py` из корня репо или `python main.py` из `server/`), иначе HTTP-tools не достучатся до `http://127.0.0.1:8787`.

Пример JSON (подставьте свои пути):

```json
{
  "mcpServers": {
    "neyra-debug": {
      "command": "Z:\\path\\to\\Neyra-AIAssist\\.venv_win\\Scripts\\python.exe",
      "args": ["Z:\\path\\to\\Neyra-AIAssist\\devtools\\mcp_server\\server.py"],
      "env": {
        "NEYRA_API_BASE": "http://127.0.0.1:8787"
      }
    }
  }
}
```

Опциональный `env`:

- `NEYRA_LOG_PATH` — явный путь к system log.
- `NEYRA_API_BASE` — base URL API (default `http://127.0.0.1:8787`). При Docker Desktop с пробросом **8787** на хосте оставьте `http://127.0.0.1:8787` там, где работает Cursor.
- `NEYRA_API_TOKEN` — Bearer, если задан `api.token` / `API_TOKEN`.
- `NEYRA_CONFIG_PATH` — альтернативный путь к `server/config.yaml` для `neyra_read_config`.

## Docker Desktop (Neyra в контейнере)

Из корня репозитория:

```bash
docker compose up --build
```

Корневой `docker-compose.yml` включает `server/docker-compose.yml`. Сервис публикует HTTP на `http://127.0.0.1:8787`. Volumes (относительно `server/`): `config.yaml`, `modules/`, `data/memory/`, `logs/`, опционально `dashboard/dist`. Секреты: `server/.env` (шаблон `server/.env.example`).

Укажите MCP тот же `NEYRA_API_BASE`. Логи контейнера видны в `server/logs/` на хосте — `read_neyra_logs` работает при checkout на хосте (или задайте `NEYRA_LOG_PATH`).

**Не** публикуйте вывод `docker compose config`, если в нём есть секреты.

## Реализация

Файлы: `devtools/mcp_server/server.py`, `devtools/mcp_server/requirements.txt`.
