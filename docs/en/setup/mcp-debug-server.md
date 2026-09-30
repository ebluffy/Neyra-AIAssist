<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Co-authored with [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# MCP debug server (`devtools/mcp_server`)

Official Python MCP SDK (`mcp` package): connect Cursor (or any MCP client) to Neyra for logs, **Control API** calls, event injection, and memory inspection. Dev-only — lives under `devtools/mcp_server/`, not in the server runtime package.

## Tools

| Tool | Purpose |
|------|---------|
| `read_neyra_logs` | Tail `server/logs/system.log` (or path from config / `NEYRA_LOG_PATH`) |
| `neyra_api_request` | Arbitrary HTTP to Control API (`GET`/`POST`/…) |
| `neyra_health` | `GET /v1/health` — quick core ping |
| `neyra_lifecycle` | `POST /v1/debug/lifecycle` — **stop**/**restart** process (admin token + lifecycle enabled; see below) |
| `neyra_fire_event` | `POST /v1/debug/fire_event` — publish to Event Bus |
| `neyra_read_config` | Read merged config with secret redaction (`server/config.yaml` + layers) |
| `neyra_write_config` | `POST /v1/config/update` — only allow-listed keys |
| `neyra_inspect_memory` | `GET /v1/debug/memory` — STM + stats + RAG |

### Lifecycle tool (`neyra_lifecycle`)

Disabled by default. The API returns **403** unless either:

- `api.debug_lifecycle_enabled: true` in merged config (`server/config/server.yaml`), or
- environment variable `NEYRA_DEBUG_LIFECYCLE` is `1` / `true` / `yes` (**opt-in**: uncomment in `docker-compose.yml` or set in `server/.env`). Prefer `POST /v1/system/restart` for restarts.

You still need the **admin** Bearer token (`API_TOKEN` / `api.token`). Actions **stop** and **restart** both end the Python process; there is no in-process re-exec. With Docker Compose and `restart: unless-stopped`, a **restart** request stops the container and Docker starts it again. Without Docker, use your process manager or start `python server/main.py` manually.

## Install

Prefer the **main project venv** (Windows: `.venv_win`, Linux/WSL: `.venv`) — `mcp` / `httpx` are covered by `server/requirements.txt`. Point Cursor MCP at that interpreter + `devtools/mcp_server/server.py`.

Optional dedicated env (only if you want isolation):

```bash
python -m venv .venv_mcp
# Windows: .venv_mcp\Scripts\activate
pip install -r devtools/mcp_server/requirements.txt
```

## Log file resolution

1. `NEYRA_LOG_PATH` if set.
2. Otherwise `logging.system_log` in merged config (same as `server/main.py`, usually `server/logs/system.log`).
3. Otherwise first existing file: `server/logs/system.log`, then `server/logs/neyra.log`.
4. Default expected path: `server/logs/system.log`.

## Cursor MCP (stdio)

In **Cursor Settings → MCP**, add a stdio server:

- **Command:** Python from the main project venv (e.g. `.venv_win\Scripts\python.exe`).
- **Args:** full path to `devtools/mcp_server/server.py`.

Cursor starts this MCP alongside the IDE; the Neyra **core** must be running separately (`python server/main.py`) so HTTP tools can reach `http://127.0.0.1:8787`.

Example JSON (adjust paths):

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

Optional `env` for the server:

- `NEYRA_LOG_PATH` — explicit system log path.
- `NEYRA_API_BASE` — API base URL (default `http://127.0.0.1:8787`).
- `NEYRA_API_TOKEN` — Bearer token if `api.token` is set (required for protected HTTP tools).
- `NEYRA_CONFIG_PATH` — alternate path to root `server/config.yaml` for `neyra_read_config`.

## Docker Desktop (Neyra in a container)

From the repo root:

```bash
docker compose up --build
```

Root `docker-compose.yml` includes `server/docker-compose.yml`. The service sets `API_BIND_HOST=0.0.0.0` so the HTTP API is reachable at `http://127.0.0.1:8787`. Volumes (relative to `server/`): `config.yaml`, `config/`, `modules/`, `data/memory/`, `logs/`, optional `dashboard/dist`. Secrets: `server/.env` (see `server/.env.example`).

Point the MCP server at the same host URL (`NEYRA_API_BASE`). Logs on the host appear under `server/logs/`.

Restart MCP / Cursor. Verify `read_neyra_logs`, then `neyra_api_request` with `GET` `/v1/health`.

## Implementation

Runtime files: `devtools/mcp_server/server.py`, `devtools/mcp_server/requirements.txt`.
