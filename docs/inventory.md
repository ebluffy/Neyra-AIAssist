# Inventory (historical Stage 1a)

> **Status:** completed. Physical migration finished in Stage **1b** (PR #14). This file is a **short historical map**, not an active checklist.
> Live keys: [`config-keys.md`](config-keys.md). Roadmap: [`PLAN.md`](PLAN.md).

## Current layout (canonical)

| Path | Role |
|------|------|
| `server/core/` | Agent, memory, reflection, plugins runtime, **Control API** (`server/core/api/`) |
| `server/modules/` | Product plugins: `discord`, `local_voice`, template `000EXAMPLE` |
| `server/dashboard/` | Server web UI (React); served by Control API |
| `server/config.yaml` + `server/config/*.yaml` | Layered configuration (Stage 1c) |
| `server/.env` | Secrets only |
| `server/data/` | Runtime data (`memory/`, dashboard auth DB, …); override `NEYRA_DATA_DIR` |
| `server/logs/` | Runtime logs |
| `client/` | Windows Tauri control app (**scaffold**; MVP = Stage 3) |
| `devtools/mcp_server/` | Dev-only MCP for Cursor |
| `docs/` | PLAN, guides, ADRs |

## Legacy → current (1b move, done)

| Was (pre-1b) | Now |
|--------------|-----|
| `core/` | `server/core/` |
| `interfaces/` | `server/modules/` |
| `frontend/` | `server/dashboard/` |
| `scripts/`, `prompts/`, `sounds/` | under `server/` |
| `tools/mcp_server/` | `devtools/mcp_server/` |
| root `memory/` | `server/data/memory/` |
| root `logs/` | `server/logs/` |
| root `config.yaml` / `.env` | `server/config.yaml` / `server/.env` |
| `interfaces/internal_api/` | removed as module; API lives in `server/core/api/`, config `api:` in `server/config/server.yaml` (Stage 2) |

## Verify layout

```bash
python server/scripts/verify_stage_1b.py
```

Migrate helper (already applied on working machines): `server/scripts/migrate_runtime_layout.py`.

## Notes

- Do not reintroduce `interfaces/`, `frontend/`, or `tools/mcp_server` paths in runtime code.
- Ignored runtime artifacts (`.env`, local YAML, Lavalink JAR, memory DBs) stay outside git; see `.gitignore` and `server/scripts/fetch_lavalink.py`.
