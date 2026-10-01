# Neyra architecture

Neyra is a stable core plus plugins under `server/modules/`.

## Layers

- `server/core/`: agent, memory, reflection, event bus, health monitor.
- `server/core/api/`: HTTP Control API + WebSocket + static SPA (`server/dashboard/dist`, React + Vite + Tailwind).
- `server/modules/discord/`: resident Discord plugin (text + music via Lavalink 4.x, `MUSIC_*` on the bus).
- `server/modules/*`: other extensions via the Plugin SDK (`local_voice`, `000EXAMPLE`, …).
- `server/config/*.yaml` + `server/config.yaml`: layered configuration; HTTP bind and dashboard settings in `server/config/server.yaml` (`api:`, `dashboard:`).
- `client/`: Tauri 2 + React scaffold (Stage 3 product client; separate from `server/dashboard/`).
- `devtools/mcp_server/`: optional IDE MCP (not shipped with runtime).

## Data flow

1. `server/main.py` loads `server/config.yaml` and layered files under `server/config/`.
2. `server/core/plugins/config.py` merges `server/modules/<id>/config.yaml`.
3. `server/core/secrets_loader.py` applies secrets from `server/.env`.
4. `server/core/runtime/server.py` starts FastAPI (Control API) and resident plugins.
5. Web dashboard, integrations, and the future Tauri client use `/v1` and `/v1/ws/*`.

## Principles

- Enable/disable a plugin: `server/modules/<id>/plugin.yaml` only.
- Plugin settings: `server/modules/<id>/config.yaml`.
- Secrets: `server/.env` only.
- Runtime data: `server/data/` (memory under `server/data/memory/`), logs under `server/logs/`.

Optional IDE tooling: MCP debug server in `devtools/mcp_server/` — see [mcp-debug-server](../setup/mcp-debug-server.md).
